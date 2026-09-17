import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { mapKnownError } from "../../apps/server/src/errors"
import { DAYS_OF_WEEK } from "../../packages/contracts/src/schedule"
import { hostReadKey } from "../../packages/core/src/host/host-reader"
import { STORAGE_CONF, storageStepCommand } from "../../packages/core/src/host/podman-facts"
import {
	PROVISION_STEPS,
	type ProvisionResult,
	provisionHost,
} from "../../packages/core/src/host/provision"
import { podmanImageId, runtimeImageFor } from "../../packages/core/src/host/runtime-image"
import { INSTANCE_UNIT_NAME, renderUnitTemplates } from "../../packages/core/src/host/unit-template"
import { sessionCacheProbeCommand } from "../../packages/core/src/instance/authenticate"
import { controlLine } from "../../packages/core/src/instance/control"
import {
	INSTANCE_STEP_TIMEOUT_MS,
	InstanceSignInRunningError,
} from "../../packages/core/src/instance/instance.controller"
import {
	CONFIG_FILE_PATH,
	configWriteCommand,
	UNIT_START_TIMEOUT_MS,
} from "../../packages/core/src/instance/unit"
import type { InstanceCommandRow } from "../../packages/db/src/index"
import { HOST_ID, installStandInClient, memoryManager, ORGANIZATION, owner } from "./memory-manager"
import {
	HOME,
	PODMAN_TARGETS,
	shellTransport,
	startPodmanHost,
	withUserManager,
} from "./podman-account"
import {
	type As,
	exec,
	journalOf,
	journalShowing,
	neverShowed,
	ROOT,
	read,
	remove,
	shell,
	succeeded,
} from "./sandbox"

const FILES = `${HOME}/.local/share/open-mcc`

const MANAGER = "systemctl --user"

const SIGN_IN_STAND_IN = [
	"[Service]",
	"Type=simple",
	"ExecCondition=",
	"ExecStartPre=",
	"ExecStart=",
	"ExecStart=/bin/sleep infinity",
	"",
].join("\n")

const INSTANCE_UNIT =
	renderUnitTemplates({ networkStack: "pasta", imageId: "0".repeat(64) })[INSTANCE_UNIT_NAME] ?? ""

const PREFLIGHT_REFUSAL =
	/echo "(open-mcc: [^"]+)" >&2/.exec(INSTANCE_UNIT)?.[1] ??
	"the rendered unit has no settings preflight"

const JOB_TIMEOUT_SECONDS = Number(/^JobTimeoutSec=(\d+)$/m.exec(INSTANCE_UNIT)?.[1])

const START_TIMEOUT_SECONDS = Number(/^TimeoutStartSec=(\d+)$/m.exec(INSTANCE_UNIT)?.[1])

const LOCK_WAIT_SECONDS = Number(
	/^ExecStartPre=\/usr\/bin\/flock -w (\d+) /m.exec(INSTANCE_UNIT)?.[1],
)

const unitSeconds = (reported: string): number =>
	Number(/(\d+)min/.exec(reported)?.[1] ?? "0") * 60 +
	Number(/(?:^|\s)(\d+)s/.exec(reported)?.[1] ?? "0")

const RESTART_REFUSED = [
	"for attempt in $(seq 150); do",
	`\tif [ "$(${MANAGER} show -p NRestarts --value "$1")" -ge 1 ] && journalctl --user -u "$1" --since "@$2" --no-pager --output cat | grep -qF -- "$3"; then exit 0; fi`,
	"\tsleep 1",
	"done",
	"exit 1",
].join("\n")

const LOCK_HOLD_MARGIN_SECONDS = 5

const botDir = (id: string): string => `${FILES}/instances/${id}`

const unitOf = (id: string): string => `open-mcc@${id}.service`

type Manager = Awaited<ReturnType<typeof memoryManager>>

describe.each(PODMAN_TARGETS)("running a bot in rootless Podman on $name", (target) => {
	let host = ""
	let as: As = ROOT
	let manager: Manager | undefined
	let provisioned: ProvisionResult | undefined
	let botId = ""

	const ready = (): { manager: Manager; provisioned: ProvisionResult } => {
		if (manager === undefined || provisioned === undefined) {
			throw new Error("the sandbox host was never provisioned")
		}
		return { manager, provisioned }
	}

	const property = async (unit: string, name: string): Promise<string> =>
		succeeded(
			await shell(host, as, `${MANAGER} show -p "$2" --value "$1"`, unit, name),
			`reading ${name} of ${unit}`,
		).trim()

	const containers = async (): Promise<string> =>
		succeeded(
			await shell(
				host,
				as,
				`podman ps --all --filter "name=^open-mcc-$1$" --format '{{.ID}} {{.ImageID}}'`,
				botId,
			),
			"listing the bot's containers",
		).trim()

	const hostClock = async (): Promise<string> =>
		succeeded(await exec(host, ROOT, ["date", "+%s"]), "reading the host's clock").trim()

	const journalSince = async (unit: string, since: string): Promise<string> =>
		await journalOf(host, as, unit, since)

	const consoleShowing = async (text: string): Promise<string> => {
		let shown = ""
		for (let attempt = 0; attempt < 40 && !shown.includes(text); attempt += 1) {
			if (attempt > 0) await delay(250)
			shown = await ready().manager.controller.readConsole(owner, botId, 200)
		}
		return shown
	}

	const removeSettings = async (): Promise<void> => {
		succeeded(
			await shell(host, as, 'rm -f -- "$1"', `${botDir(botId)}/${CONFIG_FILE_PATH}`),
			"removing the bot's settings file",
		)
	}

	beforeAll(async () => {
		host = await startPodmanHost(inject("sandbox"), target)
		as = await withUserManager(host)
	}, 2_400_000)

	afterAll(async () => {
		manager?.readConnections.evict(hostReadKey(ORGANIZATION, HOST_ID))
		await remove(host)
	}, 300_000)

	it("provisions through the manager's own steps after a setup cut off right after it wrote container storage (F3)", async () => {
		const cut = shellTransport(host, as)
		const reach = cut.exec
		let storageWritten = false
		cut.exec = async (command: string, timeoutMs: number, stdin?: string) => {
			if (storageWritten) throw new Error("the sandbox dropped the connection")
			const ran = await reach(command, timeoutMs, stdin)
			if (command === storageStepCommand()) storageWritten = true
			return ran
		}

		await expect(provisionHost(cut)).rejects.toThrow("the sandbox dropped the connection")
		expect(await read(host, `${HOME}/.config/containers/storage.conf`)).toBe(STORAGE_CONF)

		const seen: string[] = []
		provisioned = await provisionHost(shellTransport(host, as), {
			onProgress: (progress) => seen.push(progress.step),
		})

		expect(seen).toEqual([...PROVISION_STEPS])
		expect(provisioned.networkStack).toBe(target.stack)
		await installStandInClient(host, as)
		manager = await memoryManager(provisioned, () => shellTransport(host, as))
	}, 900_000)

	it("creates a bot, starts it in its own container from the pinned image, and reads what it prints", async () => {
		const { manager: ready_, provisioned: result } = ready()

		const created = await ready_.controller.create(owner, {
			hostId: HOST_ID,
			name: "sandbox-bot",
			accountType: "offline",
			minecraftAccount: "SandboxBot",
			serverAddress: "127.0.0.1",
		})
		botId = created.id
		const since = await hostClock()
		await ready_.controller.start(owner, botId)

		expect(
			await property(unitOf(botId), "ActiveState"),
			await journalSince(unitOf(botId), since),
		).toBe("active")
		expect(
			succeeded(
				await shell(
					host,
					as,
					'podman container inspect --format "{{.Image}}" "open-mcc-$1"',
					botId,
				),
				"reading the bot container's image",
			).trim(),
		).toBe(podmanImageId(runtimeImageFor(result.architecture)))
		expect(await consoleShowing("stand-in client started")).toContain("stand-in client started")
	})

	it("hands a scheduled command to the client through its control channel", async () => {
		const row: InstanceCommandRow = {
			id: randomUUID(),
			organizationId: ORGANIZATION,
			instanceId: botId,
			name: "sandbox wave",
			command: "/say hello from the schedule",
			daysOfWeek: "Mon",
			minuteOfDay: 540,
			timezone: "UTC",
			enabled: true,
			lastRunAt: null,
			lastRunError: null,
			createdAt: new Date(),
		}

		await ready().manager.controller.runScheduledCommand(row)

		const line = `stand-in client read: ${controlLine(row.command)}`
		expect(await consoleShowing(line)).toContain(line)
	})

	it("restarts the bot in a fresh container", async () => {
		const before = await containers()
		const since = await hostClock()

		await ready().manager.controller.restart(owner, botId)

		const after = await containers()
		expect(
			await property(unitOf(botId), "ActiveState"),
			await journalSince(unitOf(botId), since),
		).toBe("active")
		expect(after).not.toBe("")
		expect(after).not.toBe(before)
	})

	it("leaves a running bot's token file untouched when it is started again, and keeps it running", async () => {
		const tokenFile = `${botDir(botId)}/env`
		const before = await read(host, tokenFile)
		const since = await hostClock()

		await ready().manager.controller.start(owner, botId)

		expect(await read(host, tokenFile)).toBe(before)
		expect(
			await property(unitOf(botId), "ActiveState"),
			await journalSince(unitOf(botId), since),
		).toBe("active")
	})

	it("orders its start phase inside its job timeout inside the manager's wait", async () => {
		const job = await property(unitOf(botId), "JobTimeoutUSec")
		const perExec = await property(unitOf(botId), "TimeoutStartUSec")

		expect(unitSeconds(job), `JobTimeoutUSec is ${job}`).toBe(JOB_TIMEOUT_SECONDS)
		expect(unitSeconds(perExec), `TimeoutStartUSec is ${perExec}`).toBe(START_TIMEOUT_SECONDS)
		expect(LOCK_WAIT_SECONDS + unitSeconds(perExec)).toBeLessThan(unitSeconds(job))
		expect(UNIT_START_TIMEOUT_MS).toBeGreaterThan(unitSeconds(job) * 1000)
	})

	it("stops the bot for its sleep window and starts it again when the window ends", async () => {
		await ready().manager.controller.setSleepWindow(owner, {
			instanceId: botId,
			daysOfWeek: [...DAYS_OF_WEEK],
			stopAt: { hour: 3, minute: 0 },
			startAt: { hour: 4, minute: 0 },
			timezone: "UTC",
		})
		expect(
			succeeded(
				await shell(
					host,
					as,
					`${MANAGER} is-enabled "$1" "$2"`,
					`open-mcc-sleep-stop@${botId}.timer`,
					`open-mcc-sleep-start@${botId}.timer`,
				),
				"reading the window's timers",
			)
				.trim()
				.split("\n"),
		).toEqual(["enabled", "enabled"])

		succeeded(
			await shell(host, as, `${MANAGER} start "$1"`, `open-mcc-sleep-stop@${botId}.service`),
			"running the window's stop",
		)
		expect(await property(unitOf(botId), "ActiveState")).toBe("inactive")
		expect(await containers()).toBe("")

		succeeded(
			await shell(host, as, `${MANAGER} start "$1"`, `open-mcc-sleep-start@${botId}.service`),
			"running the window's start",
		)
		expect(await property(unitOf(botId), "ActiveState")).toBe("active")
		expect(await containers()).not.toBe("")
	})

	it("stops the bot within 40 seconds, leaving no container behind", async () => {
		const began = Date.now()

		await ready().manager.controller.stop(owner, botId)

		expect(Date.now() - began).toBeLessThan(40_000)
		expect(await property(unitOf(botId), "ActiveState")).toBe("inactive")
		expect(await containers()).toBe("")
	})

	it("answers the sign-in check from state/ alone: a cache is 0, none, an empty file or a link is 1, an unreadable state/ is 2", async () => {
		const state = `${botDir(botId)}/state`
		const cache = `${state}/SessionCache.db`
		const elsewhere = `${botDir(botId)}/elsewhere.db`
		const probe = async (): Promise<number | null> =>
			(await shell(host, as, sessionCacheProbeCommand(botId))).status
		const arrange = async (script: string, what: string): Promise<void> => {
			succeeded(await shell(host, as, script, cache, elsewhere, state), what)
		}

		await arrange('rm -f -- "$1" "$2"', "clearing the cache")
		const missing = await probe()
		await arrange(': > "$1"', "leaving an empty cache")
		const empty = await probe()
		await arrange(
			'rm -f -- "$1" && printf cache > "$2" && ln -s "$2" "$1"',
			"planting a link to a full file",
		)
		const linked = await probe()
		await arrange('rm -f -- "$1" "$2" && printf cache > "$1"', "writing a cache")
		const written = await probe()
		await arrange('chmod 000 "$3"', "making state unreadable")
		const unreadable = await probe()
		await arrange('chmod 700 "$3" && rm -f -- "$1"', "restoring state")

		expect({ written, missing, empty, linked, unreadable }).toEqual({
			written: 0,
			missing: 1,
			empty: 1,
			linked: 1,
			unreadable: 2,
		})
	})

	it("fails a sleep window's start with the settings file missing, starting no container (C8)", async () => {
		await removeSettings()
		const since = await hostClock()

		const started = await shell(
			host,
			as,
			`${MANAGER} start "$1"`,
			`open-mcc-sleep-start@${botId}.service`,
		)

		expect(started.status).not.toBe(0)
		expect(await containers()).toBe("")
		succeeded(
			await shell(
				host,
				as,
				`${MANAGER} stop "$1" "$2" && { ${MANAGER} reset-failed "$1" "$2" || true; }`,
				unitOf(botId),
				`open-mcc-sleep-start@${botId}.service`,
			),
			"stopping the refused restarts",
		)
		expect(
			await journalShowing(host, as, unitOf(botId), PREFLIGHT_REFUSAL, since),
			neverShowed(unitOf(botId), PREFLIGHT_REFUSAL),
		).toContain(PREFLIGHT_REFUSAL)
	})

	it("fails an automatic restart with the settings file missing, starting no container (C8)", async () => {
		await ready().manager.controller.start(owner, botId)
		expect(await property(unitOf(botId), "ActiveState")).toBe("active")
		await removeSettings()
		const since = await hostClock()

		succeeded(
			await shell(host, as, 'printf "/fail\\n" > "$1"', `${botDir(botId)}/control`),
			"making the client fail",
		)
		const refused = await shell(
			host,
			{ ...as, timeoutMs: 200_000 },
			RESTART_REFUSED,
			unitOf(botId),
			since,
			PREFLIGHT_REFUSAL,
		)

		expect(refused.status, await journalSince(unitOf(botId), since)).toBe(0)
		expect(await containers()).toBe("")
		succeeded(
			await shell(
				host,
				as,
				`${MANAGER} stop "$1" && { ${MANAGER} reset-failed "$1" || true; }`,
				unitOf(botId),
			),
			"stopping the refused restarts",
		)
	}, 300_000)

	it("refuses a start while the bot's sign-in runs, as INSTANCE_SIGN_IN_RUNNING, starting no container", async () => {
		await ready().manager.controller.stop(owner, botId)
		const signIn = `open-mcc-auth@${botId}.service`
		succeeded(
			await shell(
				host,
				{ ...as, input: SIGN_IN_STAND_IN },
				`mkdir -p "$1" && cat > "$1/sandbox.conf" && ${MANAGER} daemon-reload && ${MANAGER} start "$2"`,
				`${HOME}/.config/systemd/user/${signIn}.d`,
				signIn,
			),
			"holding a stand-in sign-in active",
		)
		expect(await property(signIn, "ActiveState")).toBe("active")

		const since = await hostClock()
		const refusal = await ready()
			.manager.controller.start(owner, botId)
			.then(
				() => undefined,
				(error) => (error instanceof Error ? error : new Error(String(error))),
			)

		expect(
			refusal,
			`${refusal?.message ?? "no refusal"}\n${await journalSince(unitOf(botId), since)}\n${await property(unitOf(botId), "Result")}`,
		).toBeInstanceOf(InstanceSignInRunningError)
		expect(refusal === undefined ? undefined : mapKnownError(refusal)?.errorCode).toBe(
			"INSTANCE_SIGN_IN_RUNNING",
		)
		expect(await containers()).toBe("")
		expect(ready().manager.rows.get(botId)?.status).toBe("stopped")
		succeeded(
			await shell(
				host,
				as,
				`${MANAGER} stop "$2" && rm -rf -- "$1" && ${MANAGER} daemon-reload`,
				`${HOME}/.config/systemd/user/${signIn}.d`,
				signIn,
			),
			"ending the stand-in sign-in",
		)
	})

	it("starts the bot on a settings file put in place by a rename, and keeps the old one when a write is cut short (H1)", async () => {
		const settings = `${botDir(botId)}/${CONFIG_FILE_PATH}`
		const temporaries = async (): Promise<string> =>
			succeeded(
				await shell(
					host,
					as,
					'find "$1" -maxdepth 1 -name ".MinecraftClient.ini.*" -print',
					`${botDir(botId)}/config`,
				),
				"listing the settings temporaries",
			).trim()
		const since = await hostClock()

		await ready().manager.controller.start(owner, botId)

		expect(
			await property(unitOf(botId), "ActiveState"),
			await journalSince(unitOf(botId), since),
		).toBe("active")
		expect(await containers()).not.toBe("")
		const document = await read(host, settings)
		expect(document).not.toBe("")
		expect(await temporaries()).toBe("")

		const cutShort = await shell(
			host,
			{ ...as, input: document.slice(0, -1) },
			configWriteCommand(botId, document),
		)

		expect(cutShort.status).not.toBe(0)
		expect(await read(host, settings)).toBe(document)
		expect(await temporaries()).toBe("")
	})

	it("starts a bot whose collect.lock is held past the ordinary step wait, and leaves the row running", async () => {
		await ready().manager.controller.stop(owner, botId)
		const lock = `${botDir(botId)}/collect.lock`
		const holdSeconds = INSTANCE_STEP_TIMEOUT_MS / 1000 + LOCK_HOLD_MARGIN_SECONDS
		const holding = shell(
			host,
			{ ...as, timeoutMs: 120_000 },
			'/usr/bin/flock -w 30 "$1" sleep "$2"',
			lock,
			String(holdSeconds),
		)
		succeeded(
			await shell(
				host,
				as,
				'for attempt in $(seq 50); do flock -n "$1" true || exit 0; sleep 0.1; done; exit 1',
				lock,
			),
			"waiting for the held lock",
		)
		const since = await hostClock()
		const began = Date.now()

		const refusal = await ready()
			.manager.controller.start(owner, botId)
			.then(
				() => undefined,
				(error) => (error instanceof Error ? error : new Error(String(error))),
			)

		const elapsed = Date.now() - began
		succeeded(await holding, "holding the bot's collect.lock")
		const retry = await ready()
			.manager.controller.start(owner, botId)
			.then(
				() => undefined,
				(error) => (error instanceof Error ? error : new Error(String(error))),
			)

		expect(
			{
				refusal: refusal?.message,
				waitedPastTheStepWait: elapsed > INSTANCE_STEP_TIMEOUT_MS,
				unit: await property(unitOf(botId), "ActiveState"),
				row: ready().manager.rows.get(botId)?.status,
				retry: retry === undefined ? undefined : mapKnownError(retry)?.errorCode,
			},
			await journalSince(unitOf(botId), since),
		).toEqual({
			refusal: undefined,
			waitedPastTheStepWait: true,
			unit: "active",
			row: "running",
			retry: undefined,
		})
	}, 300_000)

	it("fails the unit, rather than letting it start behind the manager, when the lock outlasts its start phase", async () => {
		await ready().manager.controller.stop(owner, botId)
		const lock = `${botDir(botId)}/collect.lock`
		const enforced = unitSeconds(await property(unitOf(botId), "TimeoutStartUSec"))
		const holding = shell(
			host,
			{ ...as, timeoutMs: 240_000 },
			'/usr/bin/flock -w 180 "$1" sleep "$2"',
			lock,
			String(enforced + LOCK_HOLD_MARGIN_SECONDS),
		)
		succeeded(
			await shell(
				host,
				as,
				'for attempt in $(seq 50); do flock -n "$1" true || exit 0; sleep 0.1; done; exit 1',
				lock,
			),
			"waiting for the held lock",
		)
		const since = await hostClock()
		const began = Date.now()

		const refusal = await ready()
			.manager.controller.start(owner, botId)
			.then(
				() => undefined,
				(error) => (error instanceof Error ? error : new Error(String(error))),
			)

		const elapsed = Date.now() - began
		const result = await property(unitOf(botId), "Result")
		const started = await containers()
		succeeded(await holding, "holding the bot's collect.lock")
		const retry = await ready()
			.manager.controller.start(owner, botId)
			.then(
				() => undefined,
				(error) => (error instanceof Error ? error : new Error(String(error))),
			)

		expect(
			{
				refused: refusal !== undefined,
				endedBeforeTheManagerGaveUp: elapsed < UNIT_START_TIMEOUT_MS,
				result,
				started,
				recovered: retry === undefined ? undefined : mapKnownError(retry)?.errorCode,
				unit: await property(unitOf(botId), "ActiveState"),
			},
			await journalSince(unitOf(botId), since),
		).toEqual({
			refused: true,
			endedBeforeTheManagerGaveUp: true,
			result: "timeout",
			started: "",
			recovered: undefined,
			unit: "active",
		})
	}, 300_000)
})

import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { mapKnownError } from "../../apps/server/src/errors"
import { DAYS_OF_WEEK } from "../../packages/contracts/src/schedule"
import { createSecretStore, generateKeyPair } from "../../packages/core/src/crypto/sealed-box"
import { hostReadKey } from "../../packages/core/src/host/host-reader"
import { STORAGE_CONF, storageStepCommand } from "../../packages/core/src/host/podman-facts"
import {
	PROVISION_STEPS,
	type ProvisionResult,
	provisionHost,
} from "../../packages/core/src/host/provision"
import { podmanImageId, runtimeImageFor } from "../../packages/core/src/host/runtime-image"
import { INSTANCE_UNIT_NAME, renderUnitTemplates } from "../../packages/core/src/host/unit-template"
import { controlLine } from "../../packages/core/src/instance/control"
import {
	type ActorContext,
	createInstanceController,
	type InstanceControllerDeps,
	InstanceSignInRunningError,
} from "../../packages/core/src/instance/instance.controller"
import { CONFIG_FILE_PATH } from "../../packages/core/src/instance/unit"
import type {
	HostRow,
	InstanceCommandRow,
	InstanceConfigRow,
	InstanceRow,
	InstanceScheduleRow,
} from "../../packages/db/src/index"
import {
	createReadConnections,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
} from "../../packages/transport/src/read-connections"
import {
	ACCOUNT,
	HOME,
	PODMAN_TARGETS,
	shellTransport,
	startPodmanHost,
	withUserManager,
} from "./podman-account"
import { type As, exec, ROOT, read, remove, shell, succeeded } from "./sandbox"

const FILES = `${HOME}/.local/share/open-mcc`

const MANAGER = "systemctl --user"

const ORGANIZATION = "org-sandbox"

const HOST_ID = "host-sandbox"

const owner: ActorContext = {
	organizationId: ORGANIZATION,
	memberId: "member-sandbox",
	actorLabel: "sandbox@example.com",
	role: "owner",
}

const STAND_IN_CLIENT = [
	"#!/opt/mcc/busybox sh",
	'echo "stand-in client started"',
	"while IFS= read -r line; do",
	'\techo "stand-in client read: $line"',
	'\tcase "$line" in',
	"\t\t/quit) exit 0 ;;",
	"\t\t/fail) exit 3 ;;",
	"\tesac",
	"done",
	"",
].join("\n")

const SIGN_IN_STAND_IN = [
	"[Service]",
	"Type=simple",
	"ExecCondition=",
	"ExecStartPre=",
	"ExecStart=",
	"ExecStart=/bin/sleep infinity",
	"",
].join("\n")

const PREFLIGHT_REFUSAL =
	/echo "(open-mcc: [^"]+)" >&2/.exec(
		renderUnitTemplates({ networkStack: "pasta", imageId: "0".repeat(64) })[INSTANCE_UNIT_NAME] ??
			"",
	)?.[1] ?? "the rendered unit has no settings preflight"

const RESTART_REFUSED = [
	"for attempt in $(seq 150); do",
	`\tif [ "$(${MANAGER} show -p NRestarts --value "$1")" -ge 1 ] && journalctl --user -u "$1" --since "@$2" --no-pager --output cat | grep -qF -- "$3"; then exit 0; fi`,
	"\tsleep 1",
	"done",
	"exit 1",
].join("\n")

const botDir = (id: string): string => `${FILES}/instances/${id}`

const unitOf = (id: string): string => `open-mcc@${id}.service`

const managerFor = async (host: string, as: As, provisioned: ProvisionResult) => {
	const secrets = await createSecretStore(await generateKeyPair("sandbox"))
	const sealed = secrets.seal("a key the sandbox's shell transport never presents")
	const hostRow: HostRow = {
		id: HOST_ID,
		organizationId: ORGANIZATION,
		name: "sandbox",
		hostname: "127.0.0.1",
		port: 22,
		username: ACCOUNT,
		networkStack: provisioned.networkStack,
		architecture: provisioned.architecture,
		osId: provisioned.osId,
		osName: provisioned.osName,
		failedUnits: null,
		teardownError: null,
		teardownRequestedAt: null,
		sshKeyId: "key-sandbox",
		hostKeyAlgorithm: "ssh-ed25519",
		hostKeyFingerprint: "SHA256:sandbox",
		hostKeyTrustedBy: null,
		hostKeyTrustedByLabel: "sandbox",
		hostKeyTrustedAt: new Date(),
		status: "ready",
		osRelease: provisioned.osRelease,
		cpuCount: null,
		memoryMb: null,
		lastSeenAt: null,
		provisioningAttemptId: null,
		provisioningClaimedAt: null,
		provisioningStep: null,
		provisioningStepIndex: null,
		provisioningStepTotal: null,
		provisioningError: null,
		createdAt: new Date(),
	}
	const rows = new Map<string, InstanceRow>()
	const configs: InstanceConfigRow[] = []
	const windows = new Map<string, InstanceScheduleRow>()

	const instances: InstanceControllerDeps["instances"] = {
		insert: async (_scope, values) => {
			const row: InstanceRow = {
				id: `bot${randomUUID().slice(0, 8)}`,
				organizationId: ORGANIZATION,
				hostId: values.hostId,
				name: values.name,
				accountType: values.accountType ?? "microsoft",
				minecraftAccount: values.minecraftAccount,
				minecraftUsername: values.minecraftUsername ?? null,
				status: values.status ?? "created",
				lastExitCode: values.lastExitCode ?? null,
				liveControlPort: values.liveControlPort,
				liveControlTokenEncrypted: values.liveControlTokenEncrypted ?? null,
				liveControlTokenKeyId: values.liveControlTokenKeyId ?? null,
				authClaimId: null,
				authClaimedAt: null,
				createdAt: new Date(),
			}
			rows.set(row.id, row)
			return row
		},
		findById: async (_scope, id) => rows.get(id),
		list: async () => [...rows.values()],
		update: async (_scope, id, patch) => {
			const current = rows.get(id)
			if (current === undefined) return undefined
			const next = { ...current, ...patch }
			rows.set(id, next)
			return next
		},
		delete: async (_scope, id) => rows.delete(id),
		claimForAuth: async (_scope, id, attemptId) => {
			const current = rows.get(id)
			if (current === undefined) return undefined
			const next = { ...current, authClaimId: attemptId, authClaimedAt: new Date() }
			rows.set(id, next)
			return next
		},
		releaseAuthClaim: async (_scope, id) => {
			const current = rows.get(id)
			if (current === undefined) return false
			rows.set(id, { ...current, authClaimId: null, authClaimedAt: null })
			return true
		},
		insertConfigVersion: async (_scope, instanceId, document, author) => {
			const row: InstanceConfigRow = {
				id: randomUUID(),
				organizationId: ORGANIZATION,
				instanceId,
				version: configs.filter((each) => each.instanceId === instanceId).length + 1,
				document: JSON.parse(document),
				authorId: author.authorId,
				authorLabel: author.authorLabel,
				createdAt: new Date(),
			}
			configs.push(row)
			return row
		},
		latestConfig: async (_scope, instanceId) =>
			configs.filter((each) => each.instanceId === instanceId).at(-1),
	}

	const schedules: InstanceControllerDeps["schedules"] = {
		upsert: async (_scope, values) => {
			const row: InstanceScheduleRow = {
				id: randomUUID(),
				organizationId: ORGANIZATION,
				createdAt: new Date(),
				...values,
			}
			windows.set(values.instanceId, row)
			return row
		},
		findByInstance: async (_scope, instanceId) => windows.get(instanceId),
		list: async () => [...windows.values()],
		delete: async (_scope, instanceId) => windows.delete(instanceId),
	}

	const commands: InstanceControllerDeps["commands"] = {
		upsert: async (_scope, values) => ({
			id: randomUUID(),
			organizationId: ORGANIZATION,
			lastRunAt: null,
			lastRunError: null,
			createdAt: new Date(),
			...values,
		}),
		listForInstance: async () => [],
		listEnabledAcrossOrganizations: async () => [],
		deleteReturning: async () => undefined,
		delete: async () => false,
		claimRun: async () => true,
		recordRun: async () => undefined,
	}

	const readConnections = createReadConnections({
		createTransport: () => shellTransport(host, as),
		idleMs: READ_CONNECTION_IDLE_MS,
		hardAgeMs: READ_CONNECTION_HARD_AGE_MS,
		channelLimit: READ_CONNECTION_CHANNEL_LIMIT,
		now: () => Date.now(),
	})

	const deps: InstanceControllerDeps = {
		instances,
		schedules,
		commands,
		hosts: { findById: async () => hostRow },
		sshKeys: {
			findById: async () => ({
				id: "key-sandbox",
				organizationId: ORGANIZATION,
				name: "sandbox",
				publicKey: "ssh-ed25519 AAAA",
				privateKeyEncrypted: sealed.ciphertext,
				privateKeyKeyId: sealed.keyId,
				createdAt: new Date(),
			}),
		},
		secrets,
		createTransport: () => shellTransport(host, as),
		readConnections,
		withTransaction: async (fn) =>
			await fn({
				instances,
				schedules,
				commands,
				audit: {
					record: async (_scope, entry) => ({
						id: randomUUID(),
						organizationId: ORGANIZATION,
						createdAt: new Date(),
						...entry,
					}),
				},
			}),
	}

	return { controller: createInstanceController(deps), rows, readConnections }
}

type Manager = Awaited<ReturnType<typeof managerFor>>

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
		succeeded(
			await shell(
				host,
				as,
				'journalctl --user -u "$1" --since "@$2" --no-pager --output cat',
				unit,
				since,
			),
			`reading the journal of ${unit}`,
		)

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
		succeeded(
			await shell(
				host,
				{ ...as, input: STAND_IN_CLIENT },
				'cp "$(command -v busybox)" "$1/busybox" && cat > "$1/MinecraftClient.stand-in" && chmod 0755 "$1/busybox" "$1/MinecraftClient.stand-in" && mv -f "$1/MinecraftClient.stand-in" "$1/MinecraftClient"',
				`${FILES}/bin`,
			),
			"installing the stand-in client",
		)
		manager = await managerFor(host, as, provisioned)
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
		expect(await journalSince(unitOf(botId), since)).toContain(PREFLIGHT_REFUSAL)
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
				(error: Error) => error,
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
})

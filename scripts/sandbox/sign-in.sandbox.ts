import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { mapKnownError } from "../../apps/server/src/errors"
import { hostReadKey } from "../../packages/core/src/host/host-reader"
import { type ProvisionResult, provisionHost } from "../../packages/core/src/host/provision"
import { podmanImageId, runtimeImageFor } from "../../packages/core/src/host/runtime-image"
import { AUTH_UNIT_NAME, renderUnitTemplates } from "../../packages/core/src/host/unit-template"
import {
	TRUNCATE_DEADLINE_SECONDS,
	TRUNCATE_KILL_AFTER_SECONDS,
} from "../../packages/core/src/instance/artifact"
import {
	AUTH_START_TIMEOUT_MS,
	DEVICE_CODE_PATTERN,
	startAuthCommand,
} from "../../packages/core/src/instance/authenticate"
import {
	DEFAULT_LIVE_CONTROL_PORT,
	defaultInstanceConfig,
	renderInstanceConfig,
} from "../../packages/core/src/instance/config"
import {
	authUnitName,
	instanceLayoutSteps,
	startUnitCommand,
	stopAuthCommand,
	unitName,
} from "../../packages/core/src/instance/unit"
import { HOST_ID, memoryManager, ORGANIZATION, owner } from "./memory-manager"
import {
	HOME,
	PODMAN_TARGETS,
	shellTransport,
	startPodmanHost,
	withUserManager,
} from "./podman-account"
import { type As, docker, journalOf, type Ran, ROOT, remove, shell, succeeded } from "./sandbox"

const BOT = "sandbox-sign-in"

const FILES = `${HOME}/.local/share/open-mcc`

const BOT_DIR = `${FILES}/instances/${BOT}`

const MANAGER = "systemctl --user"

const SIGN_IN = authUnitName(BOT)

const INSTANCE = `${unitName(BOT)}.service`

const SLEEP_START = `open-mcc-sleep-start@${BOT}.service`

const MICROSOFT_SIGN_IN = "https://login.microsoftonline.com/"

const NO_NETWORK_EXITS: readonly number[] = [6, 7, 28]

const HOLD = "open-mcc-sandbox-hold"

const dropIns = (unit: string): string => `${HOME}/.config/systemd/user/${unit}.d`

const WAITING_CLIENT = ["#!/opt/mcc/busybox sh", "exec /opt/mcc/busybox sleep 3600", ""].join("\n")

const HOLD_DROP_IN = [
	"[Service]",
	`Environment=PATH=%t/${HOLD}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
	"",
].join("\n")

const HELD_SYSTEMCTL = [
	"#!/bin/sh",
	'release="$(dirname "$0")/release"',
	'for attempt in $(seq 600); do [ -e "$release" ] && break; sleep 0.1; done',
	'out="$(/usr/bin/systemctl "$@")"',
	"rc=$?",
	"sleep 3",
	'printf "%s\\n" "$out"',
	'exit "$rc"',
	"",
].join("\n")

const BOTH_HELD = [
	"for attempt in $(seq 600); do",
	`\tif [ "$(${MANAGER} show -p SubState --value "$1")" = condition ] && [ "$(${MANAGER} show -p SubState --value "$2")" = condition ]; then touch "$XDG_RUNTIME_DIR/${HOLD}/release" && exit 0; fi`,
	"\tsleep 0.1",
	"done",
	"exit 1",
].join("\n")

const SKIP_LINE = "Skipped due to 'exec-condition'."

const SKIPPED = [
	"for attempt in $(seq 50); do",
	'\tjournalctl --user -u "$1" --since "@$2" --no-pager --output cat | grep -qF -- "$3" && exit 0',
	"\tsleep 0.1",
	"done",
	"exit 1",
].join("\n")

const JOURNAL_MARK =
	'mark=$(( $(date +%s) + 1 )); while [ "$(date +%s)" -lt "$mark" ]; do sleep 0.1; done; echo "$mark"'

const UNTIL_ENDED = [
	"for attempt in $(seq 180); do",
	`\tcase "$(${MANAGER} show -p ActiveState --value "$1")" in failed|inactive) exit 0 ;; esac`,
	"\tsleep 1",
	"done",
	"exit 1",
].join("\n")

const SIGN_IN_TEMPLATE =
	renderUnitTemplates({ networkStack: "pasta", imageId: "0".repeat(64) })[AUTH_UNIT_NAME] ?? ""

const JOB_TIMEOUT_SECONDS = Number(
	/^JobTimeoutSec=(\d+)$/m.exec(
		SIGN_IN_TEMPLATE.slice(0, SIGN_IN_TEMPLATE.indexOf("[Service]")),
	)?.[1],
)

const START_TIMEOUT_SECONDS = Number(/^TimeoutStartSec=(\d+)$/m.exec(SIGN_IN_TEMPLATE)?.[1])

const LOCK_WAIT_SECONDS = Number(
	/^ExecStartPre=\/usr\/bin\/flock -w (\d+) /m.exec(SIGN_IN_TEMPLATE)?.[1],
)

const COLLECTOR_HOLD_CEILING_SECONDS = TRUNCATE_DEADLINE_SECONDS + TRUNCATE_KILL_AFTER_SECONDS

const LOCK_HOLD_MARGIN_SECONDS = 5

const unitSeconds = (reported: string): number =>
	Number(/(\d+)min/.exec(reported)?.[1] ?? "0") * 60 +
	Number(/(?:^|\s)(\d+)s/.exec(reported)?.[1] ?? "0")

const TAKEN = 'for attempt in $(seq 50); do flock -n "$1" true || exit 0; sleep 0.1; done; exit 1'

type Manager = Awaited<ReturnType<typeof memoryManager>>

describe.each(PODMAN_TARGETS)("signing in to Microsoft in rootless Podman on $name", (target) => {
	let host = ""
	let as: As = ROOT
	let provisioned: ProvisionResult | undefined
	let manager: Manager | undefined
	let offline = false

	const ready = (): Manager => {
		if (manager === undefined) throw new Error("the sandbox host was never provisioned")
		return manager
	}

	const holding = (lock: string, seconds: number): Promise<Ran> =>
		shell(
			host,
			{ ...as, timeoutMs: 240_000 },
			'/usr/bin/flock -w 180 "$1" sleep "$2"',
			lock,
			String(seconds),
		)

	const waitForTheLock = async (lock: string): Promise<void> => {
		succeeded(await shell(host, as, TAKEN, lock), "waiting for the held lock")
	}

	const refusalOf = async <T>(run: Promise<T>): Promise<string | undefined> =>
		await run.then(
			() => undefined,
			(error) =>
				mapKnownError(error instanceof Error ? error : new Error(String(error)))?.errorCode ??
				"UNMAPPED",
		)

	const property = async (unit: string, name: string): Promise<string> =>
		succeeded(
			await shell(host, as, `${MANAGER} show -p "$2" --value "$1"`, unit, name),
			`reading ${name} of ${unit}`,
		).trim()

	const journalMark = async (): Promise<string> =>
		succeeded(await shell(host, as, JOURNAL_MARK), "marking the journal").trim()

	const skippedSince = async (unit: string, since: string): Promise<boolean> =>
		(await shell(host, as, SKIPPED, unit, since, SKIP_LINE)).status === 0

	const journalSince = async (unit: string, since: string): Promise<string> =>
		await journalOf(host, as, unit, since)

	const running = async (): Promise<string> =>
		succeeded(
			await shell(
				host,
				as,
				`podman ps --filter "name=^open-mcc-(auth-)?$1$" --format '{{.Names}}'`,
				BOT,
			),
			"listing the bot's running containers",
		).trim()

	const goOffline = async (): Promise<void> => {
		if (offline) return
		if (provisioned === undefined) throw new Error("the sandbox host was never provisioned")
		succeeded(
			await shell(
				host,
				as,
				'podman image exists "$1" && test -x "$2/bin/MinecraftClient"',
				podmanImageId(runtimeImageFor(provisioned.architecture)),
				FILES,
			),
			"finding the pinned image and the client before the network goes",
		)
		const networks = succeeded(
			await docker([
				"container",
				"inspect",
				"--format",
				"{{range $network, $settings := .NetworkSettings.Networks}}{{println $network}}{{end}}",
				host,
			]),
			"listing the host's networks",
		)
			.split("\n")
			.filter((network) => network.length > 0)
		for (const network of networks) {
			succeeded(
				await docker(["network", "disconnect", network, host]),
				`disconnecting the host from ${network}`,
			)
		}
		const interfaces = succeeded(
			await shell(host, as, "ls /sys/class/net"),
			"listing the host's network interfaces",
		)
			.split(/\s+/)
			.filter((name) => name.length > 0)
		if (interfaces.join(" ") !== "lo") {
			throw new Error(
				`the sandbox host still has a network, so no client may run: ${interfaces.join(" ")}`,
			)
		}
		const attempt = await shell(
			host,
			{ ...as, timeoutMs: 60_000 },
			'curl --silent --show-error --max-time 20 --output /dev/null "$1"',
			MICROSOFT_SIGN_IN,
		)
		if (attempt.status === null || !NO_NETWORK_EXITS.includes(attempt.status)) {
			throw new Error(
				`an HTTPS attempt to Microsoft's sign-in host did not fail for want of a network, so no client may run: exit ${attempt.status} ${attempt.stderr.trim()}`,
			)
		}
		offline = true
	}

	const installWaitingClient = async (): Promise<void> => {
		succeeded(
			await shell(
				host,
				{ ...as, input: WAITING_CLIENT },
				'cp "$(command -v busybox)" "$1/busybox" && cat > "$1/MinecraftClient.stand-in" && chmod 0755 "$1/busybox" "$1/MinecraftClient.stand-in" && mv -f "$1/MinecraftClient.stand-in" "$1/MinecraftClient"',
				`${FILES}/bin`,
			),
			"installing a stand-in client that waits",
		)
	}

	beforeAll(async () => {
		host = await startPodmanHost(inject("sandbox"), target)
		as = await withUserManager(host)
	}, 2_400_000)

	beforeAll(async () => {
		provisioned = await provisionHost(shellTransport(host, as))
		for (const step of instanceLayoutSteps({
			instanceId: BOT,
			liveControlPort: DEFAULT_LIVE_CONTROL_PORT,
			liveControlToken: "0123456789abcdef0123456789abcdef",
			configDocument: renderInstanceConfig(
				defaultInstanceConfig({
					accountType: "microsoft",
					minecraftAccount: "sandbox@example.invalid",
					serverAddress: "127.0.0.1",
				}),
			),
		})) {
			succeeded(
				await shell(
					host,
					{ ...as, ...(step.stdin === undefined ? {} : { input: step.stdin }) },
					step.command,
				),
				step.failure,
			)
		}
		manager = await memoryManager(provisioned, () => shellTransport(host, as))
	}, 900_000)

	afterAll(async () => {
		manager?.readConnections.evict(hostReadKey(ORGANIZATION, HOST_ID))
		await remove(host)
	}, 300_000)

	it("fails sign-in with a network error and status 4, only after proving the host has no network", async () => {
		await goOffline()

		try {
			const started = await shell(host, as, startAuthCommand(BOT))
			const ended = await shell(host, { ...as, timeoutMs: 200_000 }, UNTIL_ENDED, SIGN_IN)
			const log = succeeded(
				await shell(host, as, 'cat "$1/auth.log"', BOT_DIR),
				"reading the sign-in log",
			)

			expect(ended.status, `the start exited ${started.status}: ${started.stderr}\n${log}`).toBe(0)
			expect(log).toContain("Login failed : Network error.")
			expect(DEVICE_CODE_PATTERN.test(log)).toBe(false)
			expect([
				await property(SIGN_IN, "Result"),
				await property(SIGN_IN, "ExecMainStatus"),
			]).toEqual(["exit-code", "4"])
		} finally {
			succeeded(await shell(host, as, stopAuthCommand(BOT)), "clearing the ended sign-in")
		}
	})

	it("skips a sleep window's start while sign-in runs, without failing the window, and the bot stays stopped after", async () => {
		await goOffline()
		expect([await property(SIGN_IN, "ActiveState"), await running()]).toEqual(["inactive", ""])
		await installWaitingClient()
		succeeded(await shell(host, as, startAuthCommand(BOT)), "starting sign-in")

		const since = await journalMark()
		const fired = await shell(host, as, `${MANAGER} start "$1"`, SLEEP_START)
		const during = {
			window: [fired.status, await property(SLEEP_START, "Result")],
			signIn: await property(SIGN_IN, "ActiveState"),
			bot: await property(INSTANCE, "ActiveState"),
			skipped: await skippedSince(INSTANCE, since),
			running: await running(),
		}
		succeeded(await shell(host, as, stopAuthCommand(BOT)), "ending sign-in")

		expect(during, `${fired.stderr}\n${await journalSince(INSTANCE, since)}`).toEqual({
			window: [0, "success"],
			signIn: "active",
			bot: "inactive",
			skipped: true,
			running: `open-mcc-auth-${BOT}`,
		})
		expect([
			await property(SIGN_IN, "ActiveState"),
			await property(INSTANCE, "ActiveState"),
			await running(),
		]).toEqual(["inactive", "inactive", ""])
	})

	it("skips both starts when sign-in and the bot check each other at the same moment, and the bot stays stopped", async () => {
		await goOffline()
		expect([await property(SIGN_IN, "ActiveState"), await running()]).toEqual(["inactive", ""])
		await installWaitingClient()
		succeeded(
			await shell(
				host,
				{ ...as, input: HELD_SYSTEMCTL },
				`install -d -m 0700 "$XDG_RUNTIME_DIR/${HOLD}" && cat > "$XDG_RUNTIME_DIR/${HOLD}/systemctl" && chmod 0755 "$XDG_RUNTIME_DIR/${HOLD}/systemctl"`,
			),
			"installing the held systemctl",
		)
		try {
			succeeded(
				await shell(
					host,
					{ ...as, input: HOLD_DROP_IN },
					`install -d "$1" "$2" && cat > "$1/hold.conf" && cp "$1/hold.conf" "$2/hold.conf" && ${MANAGER} daemon-reload`,
					dropIns(SIGN_IN),
					dropIns(INSTANCE),
				),
				"holding both units' conditions",
			)

			const since = await journalMark()
			const [signIn, bot, held] = await Promise.all([
				shell(host, { ...as, timeoutMs: 120_000 }, startAuthCommand(BOT)),
				shell(host, { ...as, timeoutMs: 120_000 }, startUnitCommand(BOT)),
				shell(host, { ...as, timeoutMs: 120_000 }, BOTH_HELD, SIGN_IN, INSTANCE),
			])
			const skipped = {
				held: held.status,
				starts: [signIn.status, bot.status],
				states: [await property(SIGN_IN, "ActiveState"), await property(INSTANCE, "ActiveState")],
				skipped: [await skippedSince(SIGN_IN, since), await skippedSince(INSTANCE, since)],
				running: await running(),
			}
			succeeded(await shell(host, as, stopAuthCommand(BOT)), "ending sign-in")

			expect(
				skipped,
				`${signIn.stderr}\n${bot.stdout}${bot.stderr}\n${await journalSince(SIGN_IN, since)}\n${await journalSince(INSTANCE, since)}`,
			).toEqual({
				held: 0,
				starts: [0, 0],
				states: ["inactive", "inactive"],
				skipped: [true, true],
				running: "",
			})
			expect([await property(INSTANCE, "ActiveState"), await running()]).toEqual(["inactive", ""])
		} finally {
			succeeded(
				await shell(
					host,
					as,
					`rm -rf -- "$1" "$2" "$XDG_RUNTIME_DIR/${HOLD}" && ${MANAGER} daemon-reload`,
					dropIns(SIGN_IN),
					dropIns(INSTANCE),
				),
				"removing the hold",
			)
		}
	})

	it("orders its start phase inside its job timeout inside the manager's wait", async () => {
		const job = await property(SIGN_IN, "JobTimeoutUSec")
		const running = await property(SIGN_IN, "JobRunningTimeoutUSec")
		const perExec = await property(SIGN_IN, "TimeoutStartUSec")

		expect(unitSeconds(job), `JobTimeoutUSec is ${job}`).toBe(JOB_TIMEOUT_SECONDS)
		expect(unitSeconds(running), `JobRunningTimeoutUSec is ${running}`).toBe(JOB_TIMEOUT_SECONDS)
		expect(unitSeconds(perExec), `TimeoutStartUSec is ${perExec}`).toBe(START_TIMEOUT_SECONDS)
		expect(LOCK_WAIT_SECONDS + unitSeconds(perExec)).toBeLessThan(unitSeconds(job))
		expect(AUTH_START_TIMEOUT_MS).toBeGreaterThan(unitSeconds(job) * 1000)
	})

	it("starts a sign-in whose collect.lock is held past the longest the collector may hold it", async () => {
		await goOffline()
		await installWaitingClient()
		const held = holding(
			`${BOT_DIR}/collect.lock`,
			COLLECTOR_HOLD_CEILING_SECONDS + LOCK_HOLD_MARGIN_SECONDS,
		)
		await waitForTheLock(`${BOT_DIR}/collect.lock`)
		const since = await journalMark()

		const started = await shell(
			host,
			{ ...as, timeoutMs: AUTH_START_TIMEOUT_MS },
			startAuthCommand(BOT),
		)

		const survived = {
			start: started.status,
			state: await property(SIGN_IN, "ActiveState"),
			running: await running(),
		}
		succeeded(await held, "holding the bot's collect.lock")
		succeeded(await shell(host, as, stopAuthCommand(BOT)), "ending sign-in")

		expect(survived, `${started.stderr}\n${await journalSince(SIGN_IN, since)}`).toEqual({
			start: 0,
			state: "active",
			running: `open-mcc-auth-${BOT}`,
		})
	}, 300_000)

	it("fails the sign-in unit, rather than letting it start behind the manager, when the lock outlasts its start phase", async () => {
		await goOffline()
		await installWaitingClient()
		const enforced = unitSeconds(await property(SIGN_IN, "TimeoutStartUSec"))
		const held = holding(`${BOT_DIR}/collect.lock`, enforced + LOCK_HOLD_MARGIN_SECONDS)
		await waitForTheLock(`${BOT_DIR}/collect.lock`)
		const since = await journalMark()
		const began = Date.now()

		const started = await shell(
			host,
			{ ...as, timeoutMs: AUTH_START_TIMEOUT_MS },
			startAuthCommand(BOT),
		)

		const bounded = {
			refused: started.status !== 0,
			endedBeforeTheManagerGaveUp: Date.now() - began < AUTH_START_TIMEOUT_MS,
			result: await property(SIGN_IN, "Result"),
			running: await running(),
		}
		succeeded(await held, "holding the bot's collect.lock")
		succeeded(await shell(host, as, stopAuthCommand(BOT)), "clearing the failed sign-in")

		expect(bounded, `${started.stderr}\n${await journalSince(SIGN_IN, since)}`).toEqual({
			refused: true,
			endedBeforeTheManagerGaveUp: true,
			result: "timeout",
			running: "",
		})
	}, 300_000)

	it("gives the sign-in claim back when the lock outlasts the start phase, instead of holding it for the lease", async () => {
		await goOffline()
		await installWaitingClient()
		const created = await ready().controller.create(owner, {
			hostId: HOST_ID,
			name: "sandbox-sign-in-claim",
			accountType: "microsoft",
			minecraftAccount: "sandbox@example.invalid",
			serverAddress: "127.0.0.1",
		})
		await ready().controller.stop(owner, created.id)
		const lock = `${FILES}/instances/${created.id}/collect.lock`
		const enforced = unitSeconds(await property(authUnitName(created.id), "TimeoutStartUSec"))
		const held = holding(lock, enforced + LOCK_HOLD_MARGIN_SECONDS)
		await waitForTheLock(lock)
		const since = await journalMark()

		const refusal = await refusalOf(ready().controller.authenticate(owner, created.id))

		const letGo = {
			refused: refusal !== undefined,
			claim: ready().rows.get(created.id)?.authClaimId === null ? "released" : "held",
			recovered: await refusalOf(ready().controller.stop(owner, created.id)),
		}
		succeeded(await held, "holding the bot's collect.lock")

		expect(letGo, await journalSince(authUnitName(created.id), since)).toEqual({
			refused: true,
			claim: "released",
			recovered: undefined,
		})
	}, 300_000)
})

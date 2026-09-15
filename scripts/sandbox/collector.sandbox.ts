import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest"
import { withDeadline } from "../../packages/core/src/host/deadline"
import { storageStepCommand } from "../../packages/core/src/host/podman-facts"
import { renderUnitTemplates } from "../../packages/core/src/host/unit-template"
import {
	ARTIFACT_STEP_TIMEOUT_MS,
	type ArtifactStore,
	type CollectedArtifact,
	EMPTY_FINGERPRINT,
	MAILER_DATABASE_DEFAULT,
	MAILER_IGNORE_LIST_DEFAULT,
	PLAYER_LIST_FILE_DEFAULT,
	type PlayerListCursor,
	sweepHostArtifacts,
	TRUNCATE_DEADLINE_SECONDS,
	TRUNCATE_KILL_AFTER_SECONDS,
	truncateCommand,
} from "../../packages/core/src/instance/artifact"
import {
	DEFAULT_LIVE_CONTROL_PORT,
	defaultInstanceConfig,
	renderInstanceConfig,
} from "../../packages/core/src/instance/config"
import {
	instanceLayoutSteps,
	parseUnitStartState,
	startUnitCommand,
	unitName,
} from "../../packages/core/src/instance/unit"
import type { InstanceRow } from "../../packages/db/src/index"
import {
	HOME,
	PODMAN_TARGETS,
	shellTransport,
	startPodmanHost,
	withUserManager,
} from "./podman-account"
import { type As, ROOT, remove, shell, succeeded } from "./sandbox"

const BOT = "sandbox-collector"

const FILES = `${HOME}/.local/share/open-mcc`

const BOT_DIR = `${FILES}/instances/${BOT}`

const STATE = `${BOT_DIR}/state`

const REPLAYS = `${BOT_DIR}/replays`

const LOCK = `${BOT_DIR}/collect.lock`

const MANAGER = "systemctl --user"

const INSTANCE = `${unitName(BOT)}.service`

const CONTAINER = `open-mcc-${BOT}`

const BUSYBOX =
	"docker.io/library/busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662"

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

const REPLAY = "2026_09_15_10_00_00_000_1_21_4_8123_ab12cd34ef5.mcpr"

const PLANTED = [
	PLAYER_LIST_FILE_DEFAULT,
	MAILER_DATABASE_DEFAULT,
	MAILER_IGNORE_LIST_DEFAULT,
	`replay_recordings/${REPLAY}`,
] as const

const ON_THE_HOST = [
	`${STATE}/${PLAYER_LIST_FILE_DEFAULT}`,
	`${STATE}/${MAILER_DATABASE_DEFAULT}`,
	`${STATE}/${MAILER_IGNORE_LIST_DEFAULT}`,
	`${REPLAYS}/${REPLAY}`,
] as const

const DECOY = `${HOME}/decoy`

const DECOY_TEXT = "the account's own file, which no sweep may read, empty or remove\n"

const STAND_IN_CLIENT = [
	"#!/bin/sh",
	"while IFS= read -r line; do",
	'\tcase "$line" in',
	"\t\t/quit) exit 0 ;;",
	"\tesac",
	"done",
	"",
].join("\n")

const HUNG = `${HOME}/hung`

const HUNG_FLOCK = ["#!/bin/sh", "trap '' TERM", 'exec /usr/bin/flock "$@"', ""].join("\n")

const HUNG_SYSTEMCTL = ["#!/bin/sh", 'touch "$(dirname "$0")/reached"', "exec sleep 3600", ""].join(
	"\n",
)

const SWAPPED = `${HOME}/swapped`

const SWAPPED_FIND = [
	"#!/bin/sh",
	'for argument in "$@"; do',
	`\tif [ "$argument" = -printf ]; then stat -L -c '%s' "${DECOY}"; exit 0; fi`,
	`\tif [ "$argument" = -mmin ]; then printf '%s\\n' "${REPLAYS}/${REPLAY}"; exit 0; fi`,
	"done",
	'exec /usr/bin/find "$@"',
	"",
].join("\n")

const PLANT = [
	'for name in "$@"; do',
	`\tif [ "$0" = link ]; then ln -s "${DECOY}" "/data/$name"; else mkfifo "/data/$name"; fi || exit 1`,
	"done",
].join("\n")

const NOFILE_DIAGNOSIS = [
	'echo "caller hard nofile: $(ulimit -H -n)"',
	'echo "fs.nr_open: $(timeout 5 cat /proc/sys/fs/nr_open)"',
	"echo \"user service hard nofile: $(timeout 5 systemd-run --user --wait --pipe --quiet sh -c 'ulimit -H -n' 2>&1 | head -n 1)\"",
	'timeout 5 podman --log-level=debug exec "$1" true 2>&1 | grep -i -E "rlimit|nofile" | head -n 5',
	"exit 0",
].join("\n")

const TRY_THE_MOUNT_POINT = [
	'mv "$0" /data/moved; echo "rename=$?"',
	'rmdir "$0"; echo "remove=$?"',
	'echo probe > "$0/probe"; echo "write=$?"',
].join("\n")

const LOGIN_SHELL_ENDING = [
	"exec perl -e '",
	'system((getpwuid($<))[8], "-c", $ARGV[0]);',
	'print(($? & 127) ? "signal " . ($? & 127) : "exit " . ($? >> 8));',
	'\' "$1"',
].join("")

const START: PlayerListCursor = { offset: 0, fingerprint: EMPTY_FINGERPRINT, version: 0 }

const ROW: InstanceRow = {
	id: BOT,
	organizationId: "org-sandbox",
	hostId: "host-sandbox",
	name: BOT,
	minecraftAccount: "SandboxBot",
	minecraftUsername: null,
	accountType: "offline",
	status: "stopped",
	lastExitCode: null,
	liveControlPort: DEFAULT_LIVE_CONTROL_PORT,
	liveControlTokenEncrypted: null,
	liveControlTokenKeyId: null,
	authClaimId: null,
	authClaimedAt: null,
	playerListOffset: "0",
	playerListFingerprint: EMPTY_FINGERPRINT,
	playerListCursorVersion: "0",
	createdAt: new Date(),
}

const cursorStore = (beforeCommit: () => Promise<void> = async () => undefined) => {
	const state: { cursor: PlayerListCursor; kept: CollectedArtifact[] } = {
		cursor: START,
		kept: [],
	}
	const store: ArtifactStore = {
		keep: async (_instanceId, artifact) => {
			state.kept.push(artifact)
		},
		storeAndAdvance: async (_instanceId, artifact, advance) => {
			await beforeCommit()
			if (advance.version !== state.cursor.version) throw new Error("the cursor moved")
			state.kept.push(artifact)
			state.cursor = {
				offset: advance.offset + artifact.content.length,
				fingerprint: advance.fingerprint,
				version: advance.version + 1,
			}
		},
		resetCursor: async (_instanceId, version) => {
			if (version !== state.cursor.version) return false
			state.cursor = { offset: 0, fingerprint: EMPTY_FINGERPRINT, version: version + 1 }
			return true
		},
	}
	return { state, store }
}

describe.each(PODMAN_TARGETS)("collecting from a rootless Podman bot on $name", (target) => {
	let host = ""
	let as: As = ROOT

	const withPath = (directory: string): As => ({
		...as,
		env: { ...as.env, PATH: `${directory}:${DEFAULT_PATH}` },
	})

	const activeState = async (): Promise<string> =>
		succeeded(
			await shell(host, as, `${MANAGER} show -p ActiveState --value "$1"`, INSTANCE),
			"reading the bot's state",
		).trim()

	const nofileDiagnosis = async (): Promise<string> =>
		await shell(host, { ...as, timeoutMs: 30_000 }, NOFILE_DIAGNOSIS, CONTAINER).then(
			(ran) => ran.stdout.slice(0, 2000),
			(error: Error) => `diagnostic unavailable: ${error.message.slice(0, 200)}`,
		)

	const startBot = async (): Promise<void> => {
		const started = await shell(host, { ...as, timeoutMs: 120_000 }, startUnitCommand(BOT))
		if (parseUnitStartState(started.stdout)?.activeState !== "active") {
			const failure = `the bot did not start: ${started.stdout.trim()} ${started.stderr.trim().slice(0, 1000)}`
			throw new Error(`${failure}\n${await nofileDiagnosis()}`)
		}
	}

	const stopBot = async (): Promise<void> => {
		succeeded(
			await shell(host, { ...as, timeoutMs: 120_000 }, `${MANAGER} stop "$1"`, INSTANCE),
			"stopping the bot",
		)
		expect(["inactive", "failed"]).toContain(await activeState())
	}

	const sweep = async (store: ArtifactStore, cursor: PlayerListCursor, through: As = as) => {
		const began = Date.now()
		const sweeps = await sweepHostArtifacts(
			shellTransport(host, through),
			[
				{
					...ROW,
					playerListOffset: String(cursor.offset),
					playerListFingerprint: cursor.fingerprint,
					playerListCursorVersion: String(cursor.version),
				},
			],
			new Map(),
			store,
		)
		return { swept: sweeps[0], elapsed: Date.now() - began }
	}

	const decoyDigest = async (): Promise<string> =>
		succeeded(await shell(host, as, 'sha256sum "$1"', DECOY), "hashing the decoy")

	const clearPlanted = async (): Promise<void> => {
		succeeded(
			await shell(host, as, 'rm -f -- "$@"', ...ON_THE_HOST),
			"clearing what the bot planted",
		)
	}

	const installScript = async (directory: string, name: string, script: string) => {
		succeeded(
			await shell(
				host,
				{ ...as, input: script },
				'mkdir -p "$1" && cat > "$1/$2" && chmod 0755 "$1/$2"',
				directory,
				name,
			),
			`installing ${directory}/${name}`,
		)
	}

	beforeAll(async () => {
		host = await startPodmanHost(inject("sandbox"), target)
		as = await withUserManager(host)
	}, 2_400_000)

	beforeAll(async () => {
		const storage = await shell(host, as, storageStepCommand())
		expect(storage.stdout.trim(), storage.stderr).toBe("ready")
		succeeded(
			await shell(host, { ...as, timeoutMs: 600_000 }, 'podman pull --quiet "$1"', BUSYBOX),
			"pulling the pinned busybox",
		)
		const imageId = succeeded(
			await shell(host, as, `podman image inspect --format '{{.Id}}' "$1"`, BUSYBOX),
			"reading busybox's image id",
		).trim()
		for (const [name, text] of Object.entries(
			renderUnitTemplates({ networkStack: target.stack, imageId }),
		)) {
			succeeded(
				await shell(
					host,
					{ ...as, input: text },
					'mkdir -p "$HOME/.config/systemd/user" && cat > "$HOME/.config/systemd/user/$1"',
					name,
				),
				`writing ${name}`,
			)
		}
		succeeded(await shell(host, as, `${MANAGER} daemon-reload`), "reloading the account's units")
		await installScript(`${FILES}/bin`, "MinecraftClient", STAND_IN_CLIENT)
		for (const step of instanceLayoutSteps({
			instanceId: BOT,
			liveControlPort: DEFAULT_LIVE_CONTROL_PORT,
			liveControlToken: "0123456789abcdef0123456789abcdef",
			configDocument: renderInstanceConfig(
				defaultInstanceConfig({
					accountType: "offline",
					minecraftAccount: "SandboxBot",
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
		succeeded(
			await shell(host, { ...as, input: DECOY_TEXT }, 'cat > "$1"', DECOY),
			"writing the decoy",
		)
		await installScript(HUNG, "flock", HUNG_FLOCK)
		await installScript(HUNG, "systemctl", HUNG_SYSTEMCTL)
		await installScript(SWAPPED, "find", SWAPPED_FIND)
	}, 900_000)

	afterAll(async () => {
		await remove(host)
	}, 300_000)

	afterEach(async () => {
		await shell(host, { ...as, timeoutMs: 120_000 }, `${MANAGER} stop "$1"`, INSTANCE)
		await shell(host, as, 'rm -f -- "$@"', ...ON_THE_HOST)
	}, 180_000)

	const inTheBot = async (what: string, script: string, ...args: readonly string[]) => {
		const ran = await shell(
			host,
			{ ...as, timeoutMs: 60_000 },
			'systemd-run --user --wait --pipe --quiet podman exec "$@"',
			CONTAINER,
			"sh",
			"-c",
			script,
			...args,
		)
		if (ran.status !== 0) {
			const failure = `${what} exited ${ran.status}: ${ran.stderr.trim().slice(0, 1000)}`
			throw new Error(`${failure}\n${await nofileDiagnosis()}`)
		}
		return ran.stdout
	}

	it("★ keeps the replays mount point in place when the bot tries to rename or remove it", async () => {
		await startBot()

		const tried = await inTheBot(
			"trying the mount point from inside the bot",
			TRY_THE_MOUNT_POINT,
			"/data/replay_recordings",
		)
		const statusOf = (step: string): string | undefined =>
			new RegExp(`^${step}=(\\d+)$`, "m").exec(tried)?.[1]
		const probe = await shell(host, as, 'cat "$1/probe" && rm -f "$1/probe"', REPLAYS)

		expect(
			{ wrote: statusOf("write"), seenOnTheHost: probe.stdout },
			`the bot's own write must land first: ${tried}${probe.stderr}`,
		).toEqual({ wrote: "0", seenOnTheHost: "probe\n" })
		expect(
			{
				renameRefused: statusOf("rename") !== undefined && statusOf("rename") !== "0",
				removeRefused: statusOf("remove") !== undefined && statusOf("remove") !== "0",
			},
			tried,
		).toEqual({ renameRefused: true, removeRefused: true })
	})

	it.each(["link", "fifo"] as const)(
		"★ reads no %s a bot plants at every name the collector takes, before or after selection, and never waits or changes what a link points at",
		async (planted) => {
			const before = await decoyDigest()
			await clearPlanted()
			await startBot()
			await inTheBot(`planting a ${planted} at every collected name`, PLANT, planted, ...PLANTED)
			await stopBot()
			succeeded(
				await shell(
					host,
					as,
					'touch -h -d "@$(( $(date +%s) - 1200 ))" "$1"',
					`${REPLAYS}/${REPLAY}`,
				),
				"aging the planted replay past the settle time",
			)

			const memory = cursorStore()
			const selected = await sweep(memory.store, START)
			const swapped = await sweep(memory.store, START, withPath(SWAPPED))
			const left = succeeded(
				await shell(
					host,
					as,
					'for path in "$@"; do [ -L "$path" ] || [ -p "$path" ] || echo "$path"; done',
					...ON_THE_HOST,
				),
				"checking what the sweep left",
			)

			expect({
				kept: memory.state.kept.length,
				decoy: await decoyDigest(),
				selectedWaited: selected.elapsed >= ARTIFACT_STEP_TIMEOUT_MS / 2,
				swappedWaited: swapped.elapsed >= ARTIFACT_STEP_TIMEOUT_MS / 2,
				mailerBytes: [selected.swept?.mailerStateBytes, swapped.swept?.mailerStateBytes],
				left,
			}).toEqual({
				kept: 0,
				decoy: before,
				selectedWaited: false,
				swappedWaited: false,
				mailerBytes: [0, 0],
				left: "",
			})
		},
	)

	it("★ kills a hung check-and-truncate within 12 seconds, and the next start's lock wait then proceeds", async () => {
		expect(["inactive", "failed"]).toContain(await activeState())
		succeeded(await shell(host, as, 'rm -f "$1/reached"', HUNG), "clearing the hang marker")

		const began = Date.now()
		const truncating = shell(
			host,
			{ ...withPath(HUNG), timeoutMs: ARTIFACT_STEP_TIMEOUT_MS },
			truncateCommand(BOT, PLAYER_LIST_FILE_DEFAULT, { offset: 1, fingerprint: EMPTY_FINGERPRINT }),
		).then((ran) => ({ ran, at: Date.now() }))
		succeeded(
			await shell(
				host,
				as,
				'for attempt in $(seq 100); do [ -e "$1/reached" ] && exit 0; sleep 0.1; done; exit 1',
				HUNG,
			),
			"waiting for the check-and-truncate to hang inside the lock",
		)
		const starting = shell(host, { ...as, timeoutMs: 120_000 }, startUnitCommand(BOT)).then(
			(ran) => ({ ran, at: Date.now() }),
		)
		const [truncated, started] = await Promise.all([truncating, starting])

		try {
			expect(
				{
					status: truncated.ran.status,
					withinTwelveSeconds: truncated.at - began < 13_000,
					started: parseUnitStartState(started.ran.stdout)?.activeState,
					startWaitedForTheLock: started.at >= truncated.at,
				},
				`${truncated.ran.stderr}\n${started.ran.stderr}`,
			).toEqual({
				status: 137,
				withinTwelveSeconds: true,
				started: "active",
				startWaitedForTheLock: true,
			})
			expect(
				(await shell(host, as, 'flock -n "$1" true', LOCK)).status,
				"the lock is free once the start passed",
			).toBe(0)
		} finally {
			await stopBot()
		}
	})

	it("★ ends a deadline's TERM as exit 124 and its KILL as exit 137, a status the account's login shell reports rather than a signal", async () => {
		const endingOf = async (command: string): Promise<string> =>
			succeeded(
				await shell(
					host,
					{ ...as, timeoutMs: ARTIFACT_STEP_TIMEOUT_MS },
					LOGIN_SHELL_ENDING,
					command,
				),
				"running a wrapped command through the account's login shell",
			)

		const ended = await endingOf(
			withDeadline(TRUNCATE_KILL_AFTER_SECONDS, TRUNCATE_DEADLINE_SECONDS, "sleep 60"),
		)
		const killed = await endingOf(
			withDeadline(
				TRUNCATE_KILL_AFTER_SECONDS,
				TRUNCATE_DEADLINE_SECONDS,
				`sh -c 'trap "" TERM; sleep 60'`,
			),
		)

		expect([ended, killed]).toEqual(["exit 124", "exit 137"])
	})

	it("★ collects an append that lands between a sweep's read and its commit exactly once", async () => {
		expect(["inactive", "failed"]).toContain(await activeState())
		const first = "[2026/9/15 10:0]\nalice\n\n"
		const appended = "[2026/9/15 10:1]\nalice, bob\n\n"
		const list = `${STATE}/${PLAYER_LIST_FILE_DEFAULT}`
		succeeded(
			await shell(host, as, 'rm -f -- "$1" && printf "%s" "$2" > "$1"', list, first),
			"writing the player list",
		)
		let raced = false
		const memory = cursorStore(async () => {
			if (raced) return
			raced = true
			succeeded(
				await shell(host, as, 'printf "%s" "$2" >> "$1"', list, appended),
				"appending between the read and the commit",
			)
		})

		await sweep(memory.store, memory.state.cursor)
		await sweep(memory.store, memory.state.cursor)

		expect({
			kept: memory.state.kept.map((artifact) => artifact.content.toString()),
			onTheHost: succeeded(await shell(host, as, 'cat "$1"', list), "reading the player list"),
			cursor: memory.state.cursor,
		}).toEqual({
			kept: [first, appended],
			onTheHost: "",
			cursor: { offset: 0, fingerprint: EMPTY_FINGERPRINT, version: 3 },
		})
	})
})

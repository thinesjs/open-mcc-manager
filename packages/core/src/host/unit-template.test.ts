import { spawnSync } from "node:child_process"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { TRUNCATE_DEADLINE_SECONDS, TRUNCATE_KILL_AFTER_SECONDS } from "../instance/artifact"
import {
	AUTH_UNIT_NAME,
	INSTANCE_UNIT_NAME,
	renderUnitTemplates,
	SLEEP_START_UNIT_NAME,
	SLEEP_STOP_UNIT_NAME,
} from "./unit-template"

const DIR = "%h/.local/share/open-mcc/instances/%i"

const IMAGE = "b54641a0139b45834e25e82fa2cf2be60bafa6a1b6a22868bb1df7182a27a7b9"

const PORT = "$${OPEN_MCC_PORT}"

const SLIRP = "slirp4netns:port_handler=slirp4netns"

const PREFLIGHT = `ExecStartPre=/bin/sh -c 'f="${DIR}/config/MinecraftClient.ini"; [ ! -L "$$f" ] && [ -f "$$f" ] && [ -s "$$f" ] && [ -r "$$f" ] || { echo "open-mcc: the saved settings file is missing or unreadable" >&2; exit 1; }'`

const instanceUnit = (network: string): string =>
	[
		"[Unit]",
		"Description=open-mcc-manager instance %i",
		"StartLimitIntervalSec=600",
		"StartLimitBurst=5",
		"JobTimeoutSec=60",
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=notify",
		"NotifyAccess=all",
		"Delegate=yes",
		`EnvironmentFile=${DIR}/unit.env`,
		`WorkingDirectory=${DIR}`,
		`ExecCondition=/bin/sh -c 'case "$$(systemctl --user show -p ActiveState --value open-mcc-auth@%i.service)" in active|activating|deactivating|reloading) exit 1;; esac'`,
		PREFLIGHT,
		`ExecStartPre=/usr/bin/flock -w 30 "${DIR}/collect.lock" /bin/sh -c 'rm -rf -- "${DIR}/recording-cache" && mkdir -m 0700 "${DIR}/recording-cache"'`,
		`ExecStart=/bin/sh -c 'exec 3<>"${DIR}/control"; exec /usr/bin/podman run --replace --rm -d -i --pull=never --sdnotify=conmon --cgroups=split --log-driver=passthrough --init --name open-mcc-%i --user 0:0 --read-only --cap-drop=all --security-opt=no-new-privileges --env-file="${DIR}/env" -e DOTNET_BUNDLE_EXTRACT_BASE_DIR=/data -v %h/.local/share/open-mcc/bin:/opt/mcc:ro -v "${DIR}/config":/config:ro -v "${DIR}/state":/data -v "${DIR}/replays":/data/replay_recordings -v "${DIR}/recording-cache":/data/recording_cache -w /data --network=${network} -p 127.0.0.1:${PORT}:${PORT} ${IMAGE} /opt/mcc/MinecraftClient /config/MinecraftClient.ini BasicIO <&3'`,
		String.raw`ExecStop=/bin/sh -c '[ -z "$$MAINPID" ] || { timeout 5 sh -c "echo /quit > \"${DIR}/control\"" && while kill -0 $$MAINPID 2>/dev/null; do sleep 1; done; }'`,
		"StandardOutput=journal",
		"StandardError=journal",
		"TimeoutStartSec=25",
		"TimeoutStopSec=20",
		"Restart=on-failure",
		"RestartPreventExitStatus=4",
		"RestartSec=30",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n")

const signInUnit = (network: string): string =>
	[
		"[Unit]",
		"Description=open-mcc-manager sign-in for instance %i",
		"JobTimeoutSec=55",
		"",
		"[Service]",
		"Type=notify",
		"NotifyAccess=all",
		"Delegate=yes",
		`WorkingDirectory=${DIR}`,
		`ExecCondition=/bin/sh -c 'case "$$(systemctl --user show -p ActiveState --value open-mcc@%i.service)" in active|activating|deactivating|reloading) exit 1;; esac'`,
		PREFLIGHT,
		`ExecStartPre=/usr/bin/flock -w 30 "${DIR}/collect.lock" /bin/true`,
		`ExecStart=/bin/sh -c 'exec /usr/bin/podman run --replace --rm -d --pull=never --sdnotify=conmon --cgroups=split --log-driver=passthrough --init --name open-mcc-auth-%i --user 0:0 --read-only --cap-drop=all --security-opt=no-new-privileges -e DOTNET_BUNDLE_EXTRACT_BASE_DIR=/data -v %h/.local/share/open-mcc/bin:/opt/mcc:ro -v "${DIR}/config":/config:ro -v "${DIR}/state":/data -w /data --network=${network} ${IMAGE} /opt/mcc/MinecraftClient /config/MinecraftClient.ini BasicIO-NoColor </dev/null >"${DIR}/auth.log" 2>&1'`,
		"TimeoutStartSec=20",
		"TimeoutStopSec=10",
		"",
	].join("\n")

const onSlirp = renderUnitTemplates({ networkStack: "slirp4netns", imageId: IMAGE })

const onPasta = renderUnitTemplates({ networkStack: "pasta", imageId: IMAGE })

const instance = onSlirp[INSTANCE_UNIT_NAME] ?? ""

const signIn = onSlirp[AUTH_UNIT_NAME] ?? ""

const signInUnitSection = signIn.slice(0, signIn.indexOf("[Service]"))

const signInServiceSection = signIn.slice(signIn.indexOf("[Service]"))

const signInStartSeconds = Number(/^TimeoutStartSec=(\d+)$/m.exec(signInServiceSection)?.[1])

const signInLockSeconds = Number(
	/^ExecStartPre=\/usr\/bin\/flock -w (\d+) /m.exec(signInServiceSection)?.[1],
)

const lineOf = (unit: string, prefix: string): string =>
	unit.split("\n").find((line) => line.startsWith(prefix)) ?? ""

const indexOfLine = (unit: string, line: string): number => unit.split("\n").indexOf(line)

describe("the unit that runs a bot in its container", () => {
	it("is spec 4.1, byte for byte, on a Podman 4 host", () => {
		expect(onSlirp[INSTANCE_UNIT_NAME]).toBe(instanceUnit(SLIRP))
	})

	it("is spec 4.1, byte for byte, on a Podman 5 host", () => {
		expect(onPasta[INSTANCE_UNIT_NAME]).toBe(instanceUnit("pasta"))
	})

	it("skips its start while the sign-in unit for the same bot is running", () => {
		expect(lineOf(instance, "ExecCondition=")).toBe(
			`ExecCondition=/bin/sh -c 'case "$$(systemctl --user show -p ActiveState --value open-mcc-auth@%i.service)" in active|activating|deactivating|reloading) exit 1;; esac'`,
		)
	})

	it("refuses a missing or unreadable config before it takes the collector's lock or starts Podman", () => {
		const preflight = indexOfLine(instance, PREFLIGHT)
		const lock = instance
			.split("\n")
			.findIndex((line) => line.startsWith("ExecStartPre=/usr/bin/flock -w 30 "))

		expect(preflight).toBeGreaterThan(0)
		expect(lock).toBeGreaterThan(preflight)
		expect(instance.split("\n").findIndex((line) => line.startsWith("ExecStart="))).toBeGreaterThan(
			lock,
		)
	})

	it("mounts the client and the config read-only, and gives the client only its own state to write", () => {
		const start = lineOf(instance, "ExecStart=")

		for (const mount of [
			"-v %h/.local/share/open-mcc/bin:/opt/mcc:ro",
			`-v "${DIR}/config":/config:ro`,
			`-v "${DIR}/state":/data`,
			`-v "${DIR}/replays":/data/replay_recordings`,
			`-v "${DIR}/recording-cache":/data/recording_cache`,
		]) {
			expect(start).toContain(` ${mount} `)
		}
		expect(start.match(/ -v /g)).toHaveLength(5)
		expect(start).toContain(" --read-only ")
	})

	it("runs the pinned image by its ID with no pull, on the network stack the host's Podman needs", () => {
		expect(lineOf(onSlirp[INSTANCE_UNIT_NAME] ?? "", "ExecStart=")).toContain(
			` --network=${SLIRP} `,
		)
		expect(lineOf(onPasta[INSTANCE_UNIT_NAME] ?? "", "ExecStart=")).toContain(" --network=pasta ")
		expect(lineOf(instance, "ExecStart=")).toContain(" --pull=never ")
		expect(lineOf(instance, "ExecStart=")).toContain(` ${IMAGE} /opt/mcc/MinecraftClient `)
	})

	it("publishes live control only on the host's loopback, at the port unit.env names", () => {
		expect(instance).toContain(`EnvironmentFile=${DIR}/unit.env`)
		expect(lineOf(instance, "ExecStart=")).toContain(` -p 127.0.0.1:${PORT}:${PORT} `)
	})

	it("keeps the stop fix: a bounded /quit, a wait for the main process, and 20 seconds a phase", () => {
		expect(lineOf(instance, "ExecStop=")).toBe(
			String.raw`ExecStop=/bin/sh -c '[ -z "$$MAINPID" ] || { timeout 5 sh -c "echo /quit > \"${DIR}/control\"" && while kill -0 $$MAINPID 2>/dev/null; do sleep 1; done; }'`,
		)
		expect(lineOf(instance, "TimeoutStopSec=")).toBe("TimeoutStopSec=20")
	})

	it("writes no container id file and runs nothing after stop", () => {
		for (const unit of [instance, signIn]) {
			expect(unit).not.toContain("--cidfile")
			expect(unit).not.toContain("ExecStopPost")
		}
	})

	it("holds the control channel open for the client's input", () => {
		expect(lineOf(instance, "ExecStart=")).toContain(`exec 3<>"${DIR}/control"; `)
		expect(lineOf(instance, "ExecStart=")).toMatch(/ <&3'$/)
	})

	it("bounds its own start phase, and leaves the job timeout above it as a backstop", () => {
		const unitSection = instance.slice(0, instance.indexOf("[Service]"))
		const jobSeconds = Number(/^JobTimeoutSec=(\d+)$/m.exec(unitSection)?.[1])
		const startSeconds = Number(/^TimeoutStartSec=(\d+)$/m.exec(instance)?.[1])
		const lockSeconds = Number(/^ExecStartPre=\/usr\/bin\/flock -w (\d+) /m.exec(instance)?.[1])

		expect(lockSeconds).toBeGreaterThan(0)
		expect(startSeconds).toBeGreaterThan(0)
		expect(lockSeconds + startSeconds).toBeLessThan(jobSeconds)
	})

	it("keeps the start rate limit where systemd reads it, and the watchdog policy", () => {
		const unitSection = instance.slice(0, instance.indexOf("[Service]"))
		expect(unitSection).toContain("StartLimitIntervalSec=600")
		expect(unitSection).toContain("StartLimitBurst=5")
		expect(instance).toContain("RestartPreventExitStatus=4")
		expect(instance).toContain("WantedBy=default.target")
	})
})

describe("the unit that signs a bot in", () => {
	it("is spec 4.2, byte for byte, on each network stack", () => {
		expect(onSlirp[AUTH_UNIT_NAME]).toBe(signInUnit(SLIRP))
		expect(onPasta[AUTH_UNIT_NAME]).toBe(signInUnit("pasta"))
	})

	it("skips its start while the bot itself is running", () => {
		expect(lineOf(signIn, "ExecCondition=")).toBe(
			`ExecCondition=/bin/sh -c 'case "$$(systemctl --user show -p ActiveState --value open-mcc@%i.service)" in active|activating|deactivating|reloading) exit 1;; esac'`,
		)
	})

	it("checks the config, then waits for the collector's lock, before it starts", () => {
		const preflight = indexOfLine(signIn, PREFLIGHT)
		const lock = indexOfLine(
			signIn,
			`ExecStartPre=/usr/bin/flock -w 30 "${DIR}/collect.lock" /bin/true`,
		)

		expect(preflight).toBeGreaterThan(0)
		expect(lock).toBeGreaterThan(preflight)
		expect(signIn.split("\n").findIndex((line) => line.startsWith("ExecStart="))).toBeGreaterThan(
			lock,
		)
	})

	it("reads nothing, and sends everything the client prints to auth.log", () => {
		expect(lineOf(signIn, "ExecStart=")).toMatch(
			new RegExp(` </dev/null >"${DIR.replaceAll("%", "%")}/auth\\.log" 2>&1'$`),
		)
	})

	it("bounds its own start phase, and leaves the job timeout above it as a backstop", () => {
		const jobSeconds = Number(/^JobTimeoutSec=(\d+)$/m.exec(signInUnitSection)?.[1])

		expect(signInLockSeconds).toBeGreaterThan(0)
		expect(signInStartSeconds).toBeGreaterThan(0)
		expect(signInLockSeconds + signInStartSeconds).toBeLessThan(jobSeconds)
	})

	it("gives one start-phase exec longer than the collector may hold the lock it waits for", () => {
		expect(Math.min(signInLockSeconds, signInStartSeconds)).toBeGreaterThan(
			TRUNCATE_DEADLINE_SECONDS + TRUNCATE_KILL_AFTER_SECONDS,
		)
	})

	it("stops within ten seconds, never restarts, and is started only on demand", () => {
		expect(lineOf(signIn, "TimeoutStopSec=")).toBe("TimeoutStopSec=10")
		expect(signIn).not.toContain("Restart=")
		expect(signIn).not.toContain("[Install]")
	})
})

describe("every unit a host runs", () => {
	it("leaves every shell variable to the shell, escaping each dollar sign for systemd", () => {
		for (const unit of Object.values(onPasta)) {
			expect(unit.replaceAll("$$", "")).not.toContain("$")
		}
	})

	it("names no user or group, because the connecting account runs every bot", () => {
		for (const unit of Object.values(onSlirp)) {
			expect(unit).not.toContain("User=")
			expect(unit).not.toContain("Group=")
		}
	})

	it("spells every path from the account's home with %h, so no path is stored or guessed", () => {
		for (const unit of Object.values(onSlirp)) {
			const paths = unit.match(/[^\s'"=]*\.local\/share\/open-mcc[^\s'"]*/g) ?? []
			for (const path of paths) expect(path.startsWith("%h/")).toBe(true)
			expect(unit).not.toContain("/home/")
		}
	})

	it("drives its sleep units through the user manager, as before", () => {
		expect(onSlirp[SLEEP_STOP_UNIT_NAME]).toBe(
			"[Unit]\nDescription=Stop open-mcc instance %i for its sleep window\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/systemctl --user stop open-mcc@%i.service\n",
		)
		expect(onSlirp[SLEEP_START_UNIT_NAME]).toBe(
			"[Unit]\nDescription=Start open-mcc instance %i after its sleep window\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/systemctl --user start open-mcc@%i.service\n",
		)
	})

	it("refuses an image ID that is not Podman's 64 hex characters, since it lands inside a shell command", () => {
		for (const imageId of [
			`sha256:${IMAGE}`,
			IMAGE.toUpperCase(),
			IMAGE.slice(1),
			`${IMAGE}; rm -rf ~`,
		]) {
			expect(() => renderUnitTemplates({ networkStack: "pasta", imageId })).toThrow(/image/i)
		}
	})
})

const CACHE_STEP = /^ExecStartPre=\/usr\/bin\/flock -w \d+ "[^"]+" \/bin\/sh -c '(.+)'$/m.exec(
	instance,
)

const BOT = "abc123"

const scratch: string[] = []

afterEach(() => {
	for (const each of scratch.splice(0)) rmSync(each, { force: true, recursive: true })
})

const instanceOf = (home: string): string => join(home, ".local/share/open-mcc/instances", BOT)

const cacheOf = (home: string): string => join(instanceOf(home), "recording-cache")

const scratchHome = (): string => {
	const home = mkdtempSync(join(tmpdir(), "start-cache-"))
	scratch.push(home)
	mkdirSync(join(home, "bin"))
	mkdirSync(instanceOf(home), { recursive: true })
	return home
}

const leaked = (home: string, runs: number): string => {
	const cache = cacheOf(home)
	mkdirSync(cache, { mode: 0o700 })
	for (let each = 0; each < runs; each += 1) {
		const run = join(cache, `20260917_12000${each}_4711_token${each}`)
		mkdirSync(run)
		writeFileSync(join(run, "recording.tmcpr"), "raw packets")
		writeFileSync(join(run, "metaData.json"), "{}")
	}
	return cache
}

const FENCED = [
	"#!/bin/sh",
	'case "$OPEN_MCC_TEST_CACHE" in',
	'"$OPEN_MCC_TEST_HOME"/*) ;;',
	'*) echo "the rm shim was given $OPEN_MCC_TEST_CACHE, outside the scratch home" >&2; exit 111;;',
	"esac",
].join("\n")

const failingRm = (home: string, body: string): void => {
	const stub = join(home, "bin", "rm")
	writeFileSync(stub, `${FENCED}\n${body}\nexit 1\n`)
	chmodSync(stub, 0o755)
}

const rmThatStopsAfterOneEntry = (home: string): void =>
	failingRm(home, 'for each in "$OPEN_MCC_TEST_CACHE"/*; do /bin/rm -rf -- "$each"; break; done')

const rmThatTakesEverythingAndFails = (home: string): void =>
	failingRm(home, '/bin/rm -rf -- "$OPEN_MCC_TEST_CACHE"')

const emptyTheCache = (home: string) => {
	const [, step = ""] = CACHE_STEP ?? []
	return spawnSync("/bin/sh", ["-c", step.replaceAll("%h", home).replaceAll("%i", BOT)], {
		env: {
			PATH: `${join(home, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			HOME: home,
			OPEN_MCC_TEST_HOME: home,
			OPEN_MCC_TEST_CACHE: cacheOf(home),
		},
	})
}

describe("the start step that empties a bot's recording cache", () => {
	it("deletes exactly one path, and it is the scratch directory it remakes", () => {
		const [, step = ""] = CACHE_STEP ?? []
		const [deleting = "", remaking = "", ...rest] = step.split(" && ")

		expect(instance.split("\n").filter((line) => line.includes("rm -rf"))).toHaveLength(1)
		expect(deleting).toBe(`rm -rf -- "${DIR}/recording-cache"`)
		expect(remaking).toBe(`mkdir -m 0700 "${DIR}/recording-cache"`)
		expect(rest).toEqual([])
	})

	it("takes away what a hard kill leaked and remakes the cache the client writes into", () => {
		const home = scratchHome()
		const cache = leaked(home, 3)

		const ran = emptyTheCache(home)

		expect(ran.status, ran.stderr.toString()).toBe(0)
		expect(readdirSync(cache)).toEqual([])
		expect(statSync(cache).mode & 0o777).toBe(0o700)
	})

	it("makes the cache for a start that finds none", () => {
		const home = scratchHome()

		const ran = emptyTheCache(home)

		expect(ran.status, ran.stderr.toString()).toBe(0)
		expect(readdirSync(cacheOf(home))).toEqual([])
		expect(statSync(cacheOf(home)).mode & 0o777).toBe(0o700)
	})

	it("refuses the start when the delete only half-succeeds, and leaves the rest where a person can see it", () => {
		const home = scratchHome()
		const cache = leaked(home, 3)
		rmThatStopsAfterOneEntry(home)

		const ran = emptyTheCache(home)

		expect({ refused: ran.status !== 0, left: readdirSync(cache).length }).toEqual({
			refused: true,
			left: 2,
		})
	})

	it("refuses the start on a delete that failed having taken everything, rather than reading success off the empty path", () => {
		const home = scratchHome()
		const cache = leaked(home, 3)
		rmThatTakesEverythingAndFails(home)

		const ran = emptyTheCache(home)

		expect({ refused: ran.status !== 0, remade: existsSync(cache) }).toEqual({
			refused: true,
			remade: false,
		})
	})

	it("refuses to run its own rm shim against a path outside the scratch home", () => {
		const home = scratchHome()
		leaked(home, 1)
		rmThatStopsAfterOneEntry(home)

		const ran = spawnSync("/bin/sh", ["-c", 'rm -rf -- "$OPEN_MCC_TEST_CACHE"'], {
			env: {
				PATH: `${join(home, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
				OPEN_MCC_TEST_HOME: home,
				OPEN_MCC_TEST_CACHE: "/",
			},
		})

		expect({ status: ran.status, cache: existsSync(cacheOf(home)) }).toEqual({
			status: 111,
			cache: true,
		})
	})
})

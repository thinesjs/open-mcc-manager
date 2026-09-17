import { describe, expect, it } from "vitest"
import { CLIENT_PROBE_TIMEOUT_MS } from "./provision"
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
		"TimeoutStopSec=10",
		"",
	].join("\n")

const onSlirp = renderUnitTemplates({ networkStack: "slirp4netns", imageId: IMAGE })

const onPasta = renderUnitTemplates({ networkStack: "pasta", imageId: IMAGE })

const instance = onSlirp[INSTANCE_UNIT_NAME] ?? ""

const signIn = onSlirp[AUTH_UNIT_NAME] ?? ""

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

	it("bounds its whole start job, with room for the lock it waits on and the container it starts", () => {
		const unitSection = instance.slice(0, instance.indexOf("[Service]"))
		const jobSeconds = Number(/^JobTimeoutSec=(\d+)$/m.exec(unitSection)?.[1])
		const lockSeconds = Number(/^ExecStartPre=\/usr\/bin\/flock -w (\d+) /m.exec(instance)?.[1])

		expect(lockSeconds).toBeGreaterThan(0)
		expect(jobSeconds).toBeGreaterThanOrEqual(lockSeconds + CLIENT_PROBE_TIMEOUT_MS / 1000)
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

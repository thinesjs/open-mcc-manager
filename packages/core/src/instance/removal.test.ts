import { spawnSync } from "node:child_process"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	DIRECTORY_DELETE_TIMEOUT_MS,
	deleteDirectoryCommand,
	REMOVAL_STEP_TIMEOUT_MS,
	removeContainersCommand,
	removeTimersCommand,
	stopUnitsCommand,
	verifyGoneCommand,
} from "./removal"
import { validateInstanceId } from "./unit"

const ID_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

const ACCEPTED_IDS = [
	...ID_CHARACTERS.split(""),
	ID_CHARACTERS,
	"-rf",
	"--",
	"__",
	"V1StGXR8Z5jdHi6B",
]

const REJECTED_IDS = [
	"",
	".",
	"..",
	"../..",
	"a/..",
	"/",
	"*",
	"a b",
	"a%i",
	"x'y",
	"a\nb",
	"a".repeat(65),
]

const RENDERED_DELETE =
	/^timeout -k 5 30 sh -c '\{ \[ ! -e "\$HOME"\/(\S+) \] \|\| chmod -R u\+rwX -- "\$HOME"\/(\S+); \} && rm -rf -- "\$HOME"\/(\S+)'; s=\$\?; exit \$s$/

const SYSTEMCTL_STUB = [
	"#!/bin/sh",
	'printf "systemctl %s\\n" "$*" >> "$STUB_LOG"',
	'if [ "$2" = show ]; then',
	'\tcase "$6" in',
	'\t\topen-mcc@abc123.service) echo "$INSTANCE_STATE" ;;',
	'\t\topen-mcc-auth@abc123.service) echo "$SIGN_IN_STATE" ;;',
	"\t\t*) exit 1 ;;",
	"\tesac",
	"fi",
	'if [ "$2" = disable ] && [ -n "$DISABLE_FAILS" ]; then exit 1; fi',
	"exit 0",
	"",
].join("\n")

const PODMAN_STUB = [
	"#!/bin/sh",
	'printf "podman %s\\n" "$*" >> "$STUB_LOG"',
	'case "$3" in',
	'\topen-mcc-abc123) exit "$BOT_CONTAINER" ;;',
	'\topen-mcc-auth-abc123) exit "$SIGN_IN_CONTAINER" ;;',
	"esac",
	"exit 125",
	"",
].join("\n")

const TIMEOUT_STUB = ["#!/bin/sh", "shift 3", 'exec "$@"', ""].join("\n")

type HostAnswers = {
	INSTANCE_STATE?: string
	SIGN_IN_STATE?: string
	BOT_CONTAINER?: string
	SIGN_IN_CONTAINER?: string
	DISABLE_FAILS?: string
}

const scratch: string[] = []

afterEach(() => {
	for (const dir of scratch.splice(0)) {
		spawnSync("chmod", ["-R", "u+rwX", dir])
		rmSync(dir, { recursive: true, force: true })
	}
})

const stubbedHost = () => {
	const root = mkdtempSync(join(tmpdir(), "open-mcc-removal-"))
	scratch.push(root)
	const bin = join(root, "bin")
	const home = join(root, "home")
	const log = join(root, "calls")
	mkdirSync(bin)
	mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true })
	writeFileSync(join(bin, "systemctl"), SYSTEMCTL_STUB, { mode: 0o755 })
	writeFileSync(join(bin, "podman"), PODMAN_STUB, { mode: 0o755 })
	writeFileSync(join(bin, "timeout"), TIMEOUT_STUB, { mode: 0o755 })
	writeFileSync(log, "")
	const run = (command: string, answers: HostAnswers = {}) => {
		const ran = spawnSync("/bin/sh", ["-c", command], {
			encoding: "utf8",
			timeout: 10_000,
			env: {
				PATH: `${bin}:/usr/bin:/bin`,
				HOME: home,
				STUB_LOG: log,
				INSTANCE_STATE: "inactive",
				SIGN_IN_STATE: "inactive",
				BOT_CONTAINER: "1",
				SIGN_IN_CONTAINER: "1",
				DISABLE_FAILS: "",
				...answers,
			},
		})
		return {
			status: ran.status,
			calls: readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line.length > 0),
		}
	}
	return { home, units: join(home, ".config", "systemd", "user"), run }
}

describe("the commands a removal runs", () => {
	it("stops the bot and its sign-in together, hiding no failure", () => {
		expect(stopUnitsCommand("abc123")).toBe(
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop 'open-mcc@abc123.service' 'open-mcc-auth@abc123.service'",
		)
	})

	it("removes both of the bot's containers in one exec under a host deadline, keeping the outer shell", () => {
		expect(removeContainersCommand("abc123")).toBe(
			"timeout -k 3 10 podman rm -f --ignore open-mcc-abc123 open-mcc-auth-abc123; s=$?; exit $s",
		)
	})

	it("deletes the bot's directory under a host deadline, first making anything the bot locked removable", () => {
		expect(deleteDirectoryCommand("abc123")).toBe(
			`timeout -k 5 30 sh -c '{ [ ! -e "$HOME"/.local/share/open-mcc/instances/abc123 ] || chmod -R u+rwX -- "$HOME"/.local/share/open-mcc/instances/abc123; } && rm -rf -- "$HOME"/.local/share/open-mcc/instances/abc123'; s=$?; exit $s`,
		)
	})

	it("ends each destructive command's host deadline inside the wait the controller gives it", () => {
		const deadlineMs = (command: string): number => {
			const found = /^timeout -k (\d+) (\d+) /.exec(command)
			return found === null ? Number.NaN : (Number(found[1]) + Number(found[2])) * 1000
		}

		expect(deadlineMs(removeContainersCommand("abc123"))).toBe(13_000)
		expect(deadlineMs(removeContainersCommand("abc123"))).toBeLessThan(REMOVAL_STEP_TIMEOUT_MS)
		expect(deadlineMs(deleteDirectoryCommand("abc123"))).toBe(35_000)
		expect(deadlineMs(deleteDirectoryCommand("abc123"))).toBeLessThan(DIRECTORY_DELETE_TIMEOUT_MS)
	})

	it("hides no failure, looks at no process and touches no account", () => {
		const commands = [
			removeTimersCommand("abc123"),
			stopUnitsCommand("abc123"),
			removeContainersCommand("abc123"),
			verifyGoneCommand("abc123"),
			deleteDirectoryCommand("abc123"),
		]

		for (const command of commands) {
			expect(command).not.toMatch(/\|\| true|\/proc|pkill|pgrep|useradd|userdel|groupdel/)
		}
	})
})

describe("the directory an instance removal deletes", () => {
	it("is exactly that instance's own directory under the account's home, for every id the validator accepts", () => {
		for (const id of ACCEPTED_IDS) {
			const found = RENDERED_DELETE.exec(deleteDirectoryCommand(id))
			const own = `.local/share/open-mcc/instances/${validateInstanceId(id)}`

			expect([found?.[1], found?.[2], found?.[3]]).toEqual([own, own, own])
			expect(posix.basename(own)).toBe(id)
			expect(posix.dirname(posix.normalize(own))).toBe(".local/share/open-mcc/instances")
		}
	})

	it("is never rendered for an id the validator refuses", () => {
		for (const id of REJECTED_IDS) {
			expect(() => validateInstanceId(id)).toThrow()
			for (const build of [
				removeTimersCommand,
				stopUnitsCommand,
				removeContainersCommand,
				verifyGoneCommand,
				deleteDirectoryCommand,
			]) {
				expect(() => build(id)).toThrow()
			}
		}
	})

	it.runIf(process.platform === "linux")(
		"deletes a directory holding one the bot made unreadable, with a recursive GNU chmod walking in first",
		() => {
			const { home, run } = stubbedHost()
			const locked = join(
				home,
				".local",
				"share",
				"open-mcc",
				"instances",
				"abc123",
				"state",
				"locked",
			)
			mkdirSync(join(locked, "inside"), { recursive: true })
			chmodSync(locked, 0o000)

			expect(run(deleteDirectoryCommand("abc123")).status).toBe(0)
			expect(existsSync(join(home, ".local", "share", "open-mcc", "instances", "abc123"))).toBe(
				false,
			)
		},
	)

	it("succeeds when the directory is already gone, so a removal retried after its delete can finish", () => {
		const { home, run } = stubbedHost()
		mkdirSync(join(home, ".local", "share", "open-mcc", "instances"), { recursive: true })

		expect(run(deleteDirectoryCommand("abc123")).status).toBe(0)
	})

	it("removes a dangling link left where the directory was, following nothing", () => {
		const { home, run } = stubbedHost()
		const instances = join(home, ".local", "share", "open-mcc", "instances")
		mkdirSync(instances, { recursive: true })
		symlinkSync(join(home, "nowhere"), join(instances, "abc123"))

		expect(run(deleteDirectoryCommand("abc123")).status).toBe(0)
		expect(readdirSync(instances)).toEqual([])
	})

	it.runIf(process.platform === "linux")(
		"fails, keeping the tree and its secrets, when the directory above it cannot be searched",
		() => {
			const { home, run } = stubbedHost()
			const instances = join(home, ".local", "share", "open-mcc", "instances")
			mkdirSync(join(instances, "abc123", "state"), { recursive: true })
			writeFileSync(join(instances, "abc123", "env"), "MCC_MCP_AUTH_TOKEN=31337\n")
			chmodSync(instances, 0o000)
			const ran = run(deleteDirectoryCommand("abc123"))
			chmodSync(instances, 0o700)

			expect(ran.status).not.toBe(0)
			expect(existsSync(join(instances, "abc123", "env"))).toBe(true)
		},
	)
})

describe("verifying that nothing of the bot is left", () => {
	it("reads both units and both container records, and passes when every one is gone", () => {
		const { run } = stubbedHost()

		const ran = run(verifyGoneCommand("abc123"))

		expect(ran.status).toBe(0)
		expect(ran.calls).toEqual([
			"systemctl --user show -p ActiveState --value open-mcc@abc123.service",
			"systemctl --user show -p ActiveState --value open-mcc-auth@abc123.service",
			"podman container exists open-mcc-abc123",
			"podman container exists open-mcc-auth-abc123",
		])
	})

	it("clears the failed state of each unit that failed, once everything is gone", () => {
		const { run } = stubbedHost()

		const ran = run(verifyGoneCommand("abc123"), {
			INSTANCE_STATE: "failed",
			SIGN_IN_STATE: "failed",
		})

		expect(ran.status).toBe(0)
		expect(ran.calls.at(-1)).toBe(
			"systemctl --user reset-failed open-mcc@abc123.service open-mcc-auth@abc123.service",
		)
	})

	it.each([
		{ named: "the bot's unit is active", answers: { INSTANCE_STATE: "active" } },
		{ named: "the bot's unit is still starting", answers: { INSTANCE_STATE: "activating" } },
		{ named: "the bot's unit is still stopping", answers: { INSTANCE_STATE: "deactivating" } },
		{ named: "the bot's unit reports no state", answers: { INSTANCE_STATE: "" } },
		{ named: "the sign-in unit is active", answers: { SIGN_IN_STATE: "active" } },
		{ named: "the bot's container exists", answers: { BOT_CONTAINER: "0" } },
		{ named: "the sign-in container exists", answers: { SIGN_IN_CONTAINER: "0" } },
		{ named: "a container record cannot be read", answers: { SIGN_IN_CONTAINER: "125" } },
	])("fails when $named, clearing no failed state", ({ answers }) => {
		const { run } = stubbedHost()

		const ran = run(verifyGoneCommand("abc123"), { INSTANCE_STATE: "failed", ...answers })

		expect(ran.status).not.toBe(0)
		expect(ran.calls.filter((call) => call.includes("reset-failed"))).toEqual([])
	})
})

describe("taking a bot's sleep timers away", () => {
	const TIMERS = ["open-mcc-sleep-stop@abc123.timer", "open-mcc-sleep-start@abc123.timer"] as const

	it("disables and deletes both installed timers, then reloads", () => {
		const { units, run } = stubbedHost()
		for (const timer of TIMERS) writeFileSync(join(units, timer), "[Timer]\n")

		const ran = run(removeTimersCommand("abc123"))

		expect(ran.status).toBe(0)
		expect(ran.calls).toEqual([
			"systemctl --user disable --now open-mcc-sleep-stop@abc123.timer",
			"systemctl --user disable --now open-mcc-sleep-start@abc123.timer",
			"systemctl --user daemon-reload",
		])
		expect(TIMERS.filter((timer) => existsSync(join(units, timer)))).toEqual([])
	})

	it("skips a timer that was never installed", () => {
		const { units, run } = stubbedHost()
		writeFileSync(join(units, TIMERS[1]), "[Timer]\n")

		const ran = run(removeTimersCommand("abc123"))

		expect(ran.status).toBe(0)
		expect(ran.calls).toEqual([
			"systemctl --user disable --now open-mcc-sleep-start@abc123.timer",
			"systemctl --user daemon-reload",
		])
	})

	it("fails, deleting and reloading nothing, when a timer cannot be disabled", () => {
		const { units, run } = stubbedHost()
		for (const timer of TIMERS) writeFileSync(join(units, timer), "[Timer]\n")

		const ran = run(removeTimersCommand("abc123"), { DISABLE_FAILS: "1" })

		expect(ran.status).not.toBe(0)
		expect(ran.calls.filter((call) => call.includes("daemon-reload"))).toEqual([])
		expect(TIMERS.filter((timer) => existsSync(join(units, timer)))).toEqual([...TIMERS])
	})
})

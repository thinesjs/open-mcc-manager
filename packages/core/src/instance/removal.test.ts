import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as removal from "./removal"
import { processesGoneCommand, removeDirectoryCommand, stopUnitCommands } from "./removal"
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

const RENDERED_REMOVAL = /^rm -rf -- "\$HOME"\/(\S+)$/

const scratch: string[] = []

afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("the directory an instance removal deletes", () => {
	it("is exactly that instance's own directory under the account's home, for every id the validator accepts", () => {
		for (const id of ACCEPTED_IDS) {
			const target = RENDERED_REMOVAL.exec(removeDirectoryCommand(id))?.[1] ?? ""

			expect(target).toBe(`.local/share/open-mcc/instances/${validateInstanceId(id)}`)
			expect(posix.basename(target)).toBe(id)
			expect(posix.dirname(posix.normalize(target))).toBe(".local/share/open-mcc/instances")
		}
	})

	it("is never rendered for an id the validator refuses", () => {
		for (const id of REJECTED_IDS) {
			expect(() => validateInstanceId(id)).toThrow()
			expect(() => removeDirectoryCommand(id)).toThrow()
		}
	})
})

describe("removing an instance from a host whose bots share one account", () => {
	it("never creates, deletes or signals an account, since no bot has one of its own", () => {
		const commands = [
			...stopUnitCommands("abc123"),
			processesGoneCommand("abc123"),
			removeDirectoryCommand("abc123"),
		]

		for (const command of commands) {
			expect(command).not.toMatch(/useradd|userdel|groupdel|pkill|pgrep/)
		}
		expect(Object.keys(removal)).not.toContain("removeAccountCommand")
	})

	it.runIf(process.platform === "linux")(
		"finds a process working inside the directory, and finds nothing once it has gone",
		async () => {
			const home = mkdtempSync(join(tmpdir(), "open-mcc-home-"))
			scratch.push(home)
			const dir = join(home, ".local", "share", "open-mcc", "instances", "abc123")
			mkdirSync(dir, { recursive: true })
			const check = processesGoneCommand("abc123")
			const env = { PATH: "/usr/bin:/bin", HOME: home }

			const sleeper = spawn("sleep", ["30"], { cwd: dir, stdio: "ignore" })
			const exited = once(sleeper, "exit")
			try {
				expect(spawnSync("/bin/sh", ["-c", check], { env }).status).toBe(1)
			} finally {
				sleeper.kill("SIGKILL")
				await exited
			}
			expect(spawnSync("/bin/sh", ["-c", check], { env }).status).toBe(0)
		},
	)
})

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { accountWord, lingerCommand } from "./host-account"

const SUDO_SHIM = 'sudo() { for word in "$@"; do printf "%s\\0" "$word"; done; }'

const argumentsOf = (command: string): readonly string[] =>
	execFileSync("/bin/sh", ["-c", `${SUDO_SHIM}\n${command}`], { encoding: "utf8" })
		.split("\0")
		.slice(0, -1)

const ACCOUNTS = [
	["a plain account", "mcc"],
	["an account with a space", "bot runner"],
	["an account with a quote", "o'brien"],
	["an account written as a substitution", "$(id -un)"],
	["an account written as a second command", "mcc; echo second"],
	["an account written as a glob", "*"],
	["an account ending in a backslash", "mcc\\"],
	["an account with a newline in the middle", "bot\nrunner"],
	["an account starting with a newline", "\nmcc"],
	["an account ending in a newline", "mcc\n"],
	["an account starting with a dot", ".mcc"],
	["an account starting with a dash", "-mcc"],
]

const SELF_HOST_SH = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"scripts",
	"self-host.sh",
)

const FRAGMENT_START = '\tACCOUNT_WORD="$ACCOUNT"'

const FRAGMENT_END = "\tesac"

const shellRule = (): string => {
	const source = readFileSync(SELF_HOST_SH, "utf8")
	const start = source.indexOf(FRAGMENT_START)
	const end = source.indexOf(FRAGMENT_END, start)
	if (start === -1 || end === -1) {
		throw new Error("self-host.sh no longer shapes the account into a shell word")
	}
	return source.slice(start, end + FRAGMENT_END.length)
}

const shellAccountWord = (account: string): string =>
	execFileSync("/bin/sh", ["-c", `${shellRule()}\nprintf '%s' "$ACCOUNT_WORD"`], {
		env: { ACCOUNT: account, PATH: process.env.PATH ?? "/usr/bin:/bin" },
		encoding: "utf8",
	})

describe("the command that turns lingering on", () => {
	it.each(ACCOUNTS)("passes %s to loginctl as one word", (_case, account) => {
		expect(argumentsOf(lingerCommand(account))).toEqual(["loginctl", "enable-linger", account])
	})

	it("leaves an account the shell would not split alone, so the copied command reads as it always has", () => {
		expect(lingerCommand("mcc")).toBe("sudo loginctl enable-linger mcc")
		expect(lingerCommand("mcc-2.0_b")).toBe("sudo loginctl enable-linger mcc-2.0_b")
	})
})

describe("the same rule written again in scripts/self-host.sh, which cannot import this one", () => {
	it.each(ACCOUNTS)("shapes %s into the word this rule shapes it into", (_case, account) => {
		expect(shellAccountWord(account)).toBe(accountWord(account))
	})
})

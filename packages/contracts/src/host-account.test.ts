import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { lingerCommand } from "./host-account"

const SUDO_SHIM = 'sudo() { for word in "$@"; do printf "%s\\n" "$word"; done; }'

const argumentsOf = (command: string): readonly string[] =>
	execFileSync("/bin/sh", ["-c", `${SUDO_SHIM}\n${command}`], { encoding: "utf8" })
		.split("\n")
		.slice(0, -1)

describe("the command that turns lingering on", () => {
	it.each([
		["a plain account", "mcc"],
		["an account with a space", "bot runner"],
		["an account with a quote", "o'brien"],
		["an account written as a substitution", "$(id -un)"],
		["an account written as a second command", "mcc; echo second"],
		["an account written as a glob", "*"],
		["an account ending in a backslash", "mcc\\"],
	])("passes %s to loginctl as one word", (_case, account) => {
		expect(argumentsOf(lingerCommand(account))).toEqual(["loginctl", "enable-linger", account])
	})

	it("leaves an account the shell would not split alone, so the copied command reads as it always has", () => {
		expect(lingerCommand("mcc")).toBe("sudo loginctl enable-linger mcc")
		expect(lingerCommand("mcc-2.0_b")).toBe("sudo loginctl enable-linger mcc-2.0_b")
	})
})

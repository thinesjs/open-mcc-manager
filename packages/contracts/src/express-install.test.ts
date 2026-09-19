import { describe, expect, it } from "vitest"
import { EXPRESS_KEY_UNREADABLE_MESSAGE, expressInstallInput } from "./express-install"
import { ACCOUNT_NAME_REQUIREMENT, SCRIPT_HEREDOC } from "./host-setup"

const INPUT = {
	hostname: "203.0.113.9",
	port: 22,
	sshKeyId: "key-1",
	createAccount: true,
	expectedFingerprint: `SHA256:${"A".repeat(43)}`,
	credential: { kind: "password", password: "hunter2-root" },
	unlock: false,
}

const withUsername = (username: string) => expressInstallInput.safeParse({ ...INPUT, username })

const refusalFor = (username: string): readonly string[] => {
	const parsed = withUsername(username)
	return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}

describe("the account name Express carries into a shell running as root", () => {
	it("takes the names an operator would actually give it", () => {
		for (const name of ["mcc", "bots-1", "_x", "a_b-c9"]) {
			expect(withUsername(name).success).toBe(true)
		}
	})

	it("refuses a name that would close the heredoc and run the rest as root", () => {
		const injected = `mcc\n${SCRIPT_HEREDOC}\ntouch /tmp/openmcc-injection-probe\n: `

		expect(withUsername(injected).success).toBe(false)
		expect(refusalFor(injected)).toContain(ACCOUNT_NAME_REQUIREMENT)
	})

	it("refuses every other name the host itself would refuse", () => {
		for (const name of [
			"",
			"Mcc",
			"9bots",
			"-bots",
			"my account",
			"pi'; rm -rf /",
			"a".repeat(33),
		]) {
			expect(withUsername(name).success).toBe(false)
		}
	})
})

describe("what an operator is told when the key they pasted cannot be read", () => {
	it("names the passphrase and both ways forward, rather than blaming the server", () => {
		expect(EXPRESS_KEY_UNREADABLE_MESSAGE).toContain("passphrase")
		expect(EXPRESS_KEY_UNREADABLE_MESSAGE).toContain("password")
		expect(EXPRESS_KEY_UNREADABLE_MESSAGE).not.toContain("server")
	})
})

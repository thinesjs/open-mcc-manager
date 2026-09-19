import { describe, expect, it } from "vitest"
import { checkHostInput } from "./host-check"
import { ACCOUNT_NAME_REQUIREMENT, SCRIPT_HEREDOC } from "./host-setup"

const CHECK = {
	hostname: "203.0.113.9",
	port: 22,
	sshKeyId: "key-1",
	expectedFingerprint: `SHA256:${"A".repeat(43)}`,
}

const withUsername = (username: string) => checkHostInput.safeParse({ ...CHECK, username })

const refusalFor = (username: string): readonly string[] => {
	const parsed = withUsername(username)
	return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}

describe("the account name a host check is asked about", () => {
	it("takes the names an operator would actually give it", () => {
		for (const name of ["mcc", "bots-1", "_x", "a_b-c9"]) {
			expect(withUsername(name).success).toBe(true)
		}
	})

	it("refuses a name that would close the setup heredoc, as the enrol and Express inputs do", () => {
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

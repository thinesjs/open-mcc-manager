import { describe, expect, it } from "vitest"
import { deviceCodeChallenge } from "./instance"

const CHALLENGE = { userCode: "WXYZ-1234", verificationUri: "https://www.microsoft.com/link" }

describe("a sign-in code's expiry, as the browser receives it", () => {
	it("is the ISO string JSON carries, since nothing on the wire turns it back into a date", () => {
		expect(
			deviceCodeChallenge.safeParse({ ...CHALLENGE, expiresAt: "2026-09-15T12:15:00.000Z" })
				.success,
		).toBe(true)
	})

	it("refuses a string that is not a timestamp", () => {
		expect(
			deviceCodeChallenge.safeParse({ ...CHALLENGE, expiresAt: "in fifteen minutes" }).success,
		).toBe(false)
	})
})

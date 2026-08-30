import { describe, expect, it } from "vitest"
import { redact } from "./redact"

describe("redact", () => {
	it("masks a bearer token", () => {
		expect(redact("Authorization: Bearer abc123def456")).not.toContain("abc123def456")
	})

	it("masks an ssh private key block", () => {
		const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----"
		expect(redact(key)).not.toContain("secret")
	})

	it("masks a device user code", () => {
		expect(redact("enter code ABCD-EFGH to continue")).not.toContain("ABCD-EFGH")
	})

	it("leaves ordinary text alone", () => {
		expect(redact("connected to server")).toBe("connected to server")
	})
})

import { describe, expect, it } from "vitest"
import { hashPassword, PASSWORD_OPTIONS, verifyPassword } from "./password"

describe("password hashing", () => {
	it("produces an argon2id hash", async () => {
		const hash = await hashPassword("correct horse battery staple")
		expect(hash.startsWith("$argon2id$")).toBe(true)
	})

	it("uses the OWASP baseline parameters", () => {
		expect(PASSWORD_OPTIONS.memoryCost).toBe(19456)
		expect(PASSWORD_OPTIONS.timeCost).toBe(2)
		expect(PASSWORD_OPTIONS.parallelism).toBe(1)
	})

	it("salts so two hashes of the same password differ", async () => {
		const a = await hashPassword("same-password")
		const b = await hashPassword("same-password")
		expect(a).not.toBe(b)
	})

	it("verifies a correct password and rejects a wrong one", async () => {
		const hash = await hashPassword("s3cret-passphrase")
		expect(await verifyPassword(hash, "s3cret-passphrase")).toBe(true)
		expect(await verifyPassword(hash, "wrong-passphrase")).toBe(false)
	})
})

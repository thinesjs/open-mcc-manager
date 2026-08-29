import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { fingerprintFromKey, parseHostKey } from "./ssh"

describe("fingerprintFromKey", () => {
	it("produces an OpenSSH SHA256 fingerprint", () => {
		const key = Buffer.from("test-key-material")
		const expected = createHash("sha256").update(key).digest("base64").replace(/=+$/, "")
		expect(fingerprintFromKey(key)).toBe(`SHA256:${expected}`)
	})
})

describe("parseHostKey", () => {
	it("accepts a well-formed host key", () => {
		const result = parseHostKey({ algorithm: "ssh-ed25519", fingerprint: "SHA256:abc" })
		expect(result).toEqual({ algorithm: "ssh-ed25519", fingerprint: "SHA256:abc" })
	})

	it("rejects a malformed host key", () => {
		expect(() => parseHostKey({ algorithm: 42 })).toThrow()
		expect(() => parseHostKey(null)).toThrow()
	})
})

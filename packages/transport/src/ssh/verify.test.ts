import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
import { describe, expect, it } from "vitest"
import { verifyHostKey } from "./verify"

const key = Buffer.from("host-key-material")
const good = fingerprintFromKey(key)

describe("verifyHostKey", () => {
	it("accepts a matching fingerprint", () => {
		expect(verifyHostKey(key, good)).toEqual({ ok: true, fingerprint: good })
	})

	it("rejects a mismatched fingerprint without revealing a match", () => {
		const result = verifyHostKey(key, "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.presented).toBe(good)
			expect(result.expected).toBe("SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
		}
	})

	it("rejects an empty expected fingerprint rather than trusting on first use", () => {
		expect(verifyHostKey(key, "").ok).toBe(false)
	})
})

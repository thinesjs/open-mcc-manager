import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { algorithmFromKey, fingerprintFromKey, parseHostKey } from "./ssh"

const encodeAlgorithmBlob = (algorithm: string, extra: Buffer = Buffer.alloc(0)): Buffer => {
	const name = Buffer.from(algorithm, "ascii")
	const length = Buffer.alloc(4)
	length.writeUInt32BE(name.length, 0)
	return Buffer.concat([length, name, extra])
}

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

describe("algorithmFromKey", () => {
	it("reads the algorithm name from an ed25519 key blob", () => {
		const blob = encodeAlgorithmBlob("ssh-ed25519", Buffer.from("fake-ed25519-key-material"))
		expect(algorithmFromKey(blob)).toBe("ssh-ed25519")
	})

	it("reads the algorithm name from an rsa key blob", () => {
		const blob = encodeAlgorithmBlob("ssh-rsa", Buffer.from("fake-rsa-key-material"))
		expect(algorithmFromKey(blob)).toBe("ssh-rsa")
	})

	it("rejects a buffer too short to hold a length prefix", () => {
		expect(() => algorithmFromKey(Buffer.from([1, 2, 3]))).toThrow(/too short/i)
	})

	it("rejects a declared length exceeding the remaining buffer", () => {
		const length = Buffer.alloc(4)
		length.writeUInt32BE(100, 0)
		const blob = Buffer.concat([length, Buffer.from("short")])
		expect(() => algorithmFromKey(blob)).toThrow(/exceeding/i)
	})

	it("rejects a declared length of zero", () => {
		const length = Buffer.alloc(4)
		length.writeUInt32BE(0, 0)
		expect(() => algorithmFromKey(length)).toThrow(/empty/i)
	})
})

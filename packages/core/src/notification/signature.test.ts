import { createHmac } from "node:crypto"
import { SIGNATURE_VERSION, SIGNING_SECRET_PREFIX } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import {
	generateSigningSecret,
	signatureHeader,
	signedContent,
	signingKeyBytes,
	signPayload,
	verifySignature,
} from "./signature"

const VECTOR = {
	secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
	id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
	timestamp: "1614265330",
	body: '{"test": 2432232314}',
	signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
} as const

const WRONG_KEY_SIGNATURE = "TcxlhK9b6UD6iVI1ZU2tTqp8PEVfYRseNNfa6b+LcUg="

describe("the signing secret", () => {
	it("is prefixed so an operator can recognise it", () => {
		expect(generateSigningSecret().startsWith(SIGNING_SECRET_PREFIX)).toBe(true)
	})

	it("carries 32 bytes of randomness", () => {
		expect(signingKeyBytes(generateSigningSecret())).toHaveLength(32)
	})

	it("is different every time", () => {
		expect(generateSigningSecret()).not.toBe(generateSigningSecret())
	})

	it("decodes a known secret to the exact bytes the specification expects", () => {
		expect(signingKeyBytes(VECTOR.secret).toString("hex")).toBe(
			"31f290f6bf06298aab4f08d43c3f082cf648a362da2da4b0",
		)
	})

	it("reads a bare secret and a prefixed one as the same key", () => {
		const bare = VECTOR.secret.slice(SIGNING_SECRET_PREFIX.length)
		expect(signingKeyBytes(bare).equals(signingKeyBytes(VECTOR.secret))).toBe(true)
		expect(signPayload(bare, VECTOR.id, VECTOR.timestamp, VECTOR.body)).toBe(VECTOR.signature)
	})
})

describe("the published test vector, which nothing here computed", () => {
	it("reproduces it exactly", () => {
		expect(signPayload(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body)).toBe(
			VECTOR.signature,
		)
	})

	it("proves the key is the decoded bytes and not the secret string", () => {
		const fromTheString = `${SIGNATURE_VERSION},${createHmac("sha256", VECTOR.secret)
			.update(signedContent(VECTOR.id, VECTOR.timestamp, VECTOR.body), "utf8")
			.digest("base64")}`

		expect(fromTheString).toBe(`${SIGNATURE_VERSION},${WRONG_KEY_SIGNATURE}`)
		expect(signPayload(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body)).not.toBe(
			fromTheString,
		)
	})

	it("proves the standard alphabet is used, padding and all", () => {
		expect(VECTOR.signature).toContain("+")
		expect(VECTOR.signature).toContain("/")
		expect(VECTOR.signature.endsWith("=")).toBe(true)
	})

	it("verifies as a receiver holding only that secret would", () => {
		expect(
			verifySignature(VECTOR.signature, VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body),
		).toBe(true)
	})
})

describe("what gets signed", () => {
	it("binds the id and the timestamp to the body", () => {
		expect(signedContent("id", "123", "{}")).toBe("id.123.{}")
	})

	it("changes if any part changes, so a captured request cannot be replayed", () => {
		const secret = generateSigningSecret()
		const base = signPayload(secret, "a", "1", "{}")

		expect(signPayload(secret, "b", "1", "{}")).not.toBe(base)
		expect(signPayload(secret, "a", "2", "{}")).not.toBe(base)
		expect(signPayload(secret, "a", "1", '{"x":1}')).not.toBe(base)
	})

	it("uses standard base64, not the url-safe alphabet", () => {
		const signature = signPayload(generateSigningSecret(), "a", "1", "{}").split(",")[1] ?? ""
		expect(signature).not.toMatch(/[-_]/)
	})
})

describe("verifying a signature", () => {
	const secret = generateSigningSecret()
	const body = '{"event":"host.unreachable"}'

	it("accepts a signature we produced", () => {
		const header = signatureHeader([secret], "msg_1", "1757000000", body)
		expect(verifySignature(header, secret, "msg_1", "1757000000", body)).toBe(true)
	})

	it("rejects a tampered body", () => {
		const header = signatureHeader([secret], "msg_1", "1757000000", body)
		expect(verifySignature(header, secret, "msg_1", "1757000000", '{"event":"nothing"}')).toBe(
			false,
		)
	})

	it("rejects a replay under a fresh timestamp", () => {
		const header = signatureHeader([secret], "msg_1", "1757000000", body)
		expect(verifySignature(header, secret, "msg_1", "1757009999", body)).toBe(false)
	})

	it("rejects a signature made with another secret", () => {
		const header = signatureHeader([generateSigningSecret()], "msg_1", "1757000000", body)
		expect(verifySignature(header, secret, "msg_1", "1757000000", body)).toBe(false)
	})

	it("accepts either signature during a rotation overlap", () => {
		const previous = generateSigningSecret()
		const header = signatureHeader([secret, previous], "msg_1", "1757000000", body)

		expect(header.split(" ")).toHaveLength(2)
		expect(verifySignature(header, secret, "msg_1", "1757000000", body)).toBe(true)
		expect(verifySignature(header, previous, "msg_1", "1757000000", body)).toBe(true)
	})
})

import { describe, expect, it } from "vitest"
import { encodedWord, messageBytes, wrappedBase64 } from "./smtp.message"

const at = new Date("2026-09-07T12:00:00.000Z")

const message = (text: string) => ({
	id: "msg_1",
	from: "alerts@example.com",
	to: ["on-call@example.com"],
	subject: "basement-box is unreachable",
	text,
	at,
})

const bodyLines = (text: string): string[] => {
	const bytes = messageBytes(message(text))
	const blank = bytes.indexOf("\r\n\r\n")
	return bytes.slice(blank + 4).split("\r\n")
}

describe("encoding a message body for the wire", () => {
	it("never emits a base64 line longer than the 76 characters mime allows", () => {
		for (const length of [1, 56, 57, 113, 114, 500]) {
			const lines = wrappedBase64("x".repeat(length)).split("\r\n")
			for (const line of lines) expect(line.length).toBeLessThanOrEqual(76)
		}
	})

	it("round-trips a body whose encoding lands exactly on the line boundary", () => {
		for (const length of [57, 114]) {
			const text = "x".repeat(length)
			const decoded = Buffer.from(wrappedBase64(text).replace(/\r\n/g, ""), "base64").toString(
				"utf8",
			)
			expect(decoded).toBe(text)
		}
	})

	it("round-trips a body that does not land on the boundary", () => {
		const text = "The last three checks did not answer."
		const decoded = Buffer.from(wrappedBase64(text).replace(/\r\n/g, ""), "base64").toString("utf8")
		expect(decoded).toBe(text)
	})

	it("round-trips text that is not printable ascii", () => {
		const text = "café — ünicode ☃"
		const decoded = Buffer.from(wrappedBase64(text).replace(/\r\n/g, ""), "base64").toString("utf8")
		expect(decoded).toBe(text)
	})
})

describe("what the smtp terminator could collide with", () => {
	it("emits no mail-data line beginning with a dot, even for adversarial text", () => {
		const adversarial = [
			".",
			".\r\n.\r\n",
			"\r\n.\r\n",
			".hidden leading dot",
			"a line\r\n. then a dot",
			"..\r\n...",
		]

		for (const text of adversarial) {
			for (const line of bodyLines(text)) expect(line.startsWith(".")).toBe(false)
		}
	})

	it("keeps a dot-only body recoverable, so the guard is not silently dropping content", () => {
		const decoded = Buffer.from(bodyLines(".").join(""), "base64").toString("utf8")
		expect(decoded).toBe(".")
	})
})

describe("a subject that is not plain ascii", () => {
	it("leaves printable ascii alone rather than encoding it needlessly", () => {
		expect(encodedWord("basement-box is unreachable")).toBe("basement-box is unreachable")
	})

	it("encodes anything else as a mime encoded-word", () => {
		expect(encodedWord("café")).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
	})
})

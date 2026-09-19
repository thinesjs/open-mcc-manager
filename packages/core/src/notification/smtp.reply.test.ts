import { describe, expect, it } from "vitest"
import { advertises, authMechanisms, isTransient, readReply } from "./smtp.reply"

describe("reading a reply off the wire", () => {
	it("reads a single line and reports what is left over", () => {
		const result = readReply("250 OK\r\nleftover")
		expect(result.read && result.reply).toEqual({ code: 250, lines: ["OK"] })
		expect(result.read && result.rest).toBe("leftover")
	})

	it("waits for the whole reply rather than acting on a fragment", () => {
		expect(readReply("250 OK").read).toBe(false)
		expect(readReply("250-STARTTLS\r\n").read).toBe(false)
		expect(readReply("").read).toBe(false)
	})

	it("reads a multi-line reply and keeps every line", () => {
		const result = readReply("250-mail.example.com\r\n250-PIPELINING\r\n250 STARTTLS\r\n")
		expect(result.read && result.reply).toEqual({
			code: 250,
			lines: ["mail.example.com", "PIPELINING", "STARTTLS"],
		})
		expect(result.read && result.rest).toBe("")
	})

	it("takes the code from the last line, not the first", () => {
		const result = readReply("250-accepted so far\r\n550 no such mailbox\r\n")
		expect(result.read && result.reply.code).toBe(550)
	})

	it("refuses a line that is not a reply at all", () => {
		expect(readReply("hello there\r\n").read).toBe(false)
		expect(readReply("25 OK\r\n").read).toBe(false)
	})

	it("hands back everything after the reply so injected bytes can be noticed", () => {
		const result = readReply("220 go ahead\r\n250 injected\r\n")
		expect(result.read && result.reply.code).toBe(220)
		expect(result.read && result.rest).toBe("250 injected\r\n")
	})
})

describe("reading what a server says it can do", () => {
	const greeting = readReply(
		"250-mail.example.com\r\n250-PIPELINING\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n",
	)

	it("finds an advertised keyword regardless of case", () => {
		expect(greeting.read && advertises(greeting.reply, "STARTTLS")).toBe(true)
		expect(greeting.read && advertises(greeting.reply, "starttls")).toBe(true)
		expect(greeting.read && advertises(greeting.reply, "SIZE")).toBe(false)
	})

	it("does not mistake a keyword appearing as an argument for an advertisement", () => {
		const reply = readReply("250 AUTH STARTTLS\r\n")
		expect(reply.read && advertises(reply.reply, "STARTTLS")).toBe(false)
	})

	it("lists the authentication mechanisms", () => {
		expect(greeting.read && authMechanisms(greeting.reply)).toEqual(["PLAIN", "LOGIN"])
	})
})

describe("deciding whether a refusal is worth another attempt", () => {
	it("treats 4xx as temporary and 5xx as permanent", () => {
		expect(isTransient(421)).toBe(true)
		expect(isTransient(450)).toBe(true)
		expect(isTransient(452)).toBe(true)
		expect(isTransient(550)).toBe(false)
		expect(isTransient(554)).toBe(false)
		expect(isTransient(250)).toBe(false)
	})
})

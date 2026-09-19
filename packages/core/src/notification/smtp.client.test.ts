import { afterEach, describe, expect, it } from "vitest"
import {
	type Answer,
	clientUpgrade,
	dial,
	EHLO_NO_TLS,
	EHLO_WITH_TLS,
	type Fake,
	HOSTNAME,
	happyPath,
	serverSideTls,
	startFake,
} from "../test/smtp-fake"
import { converse, plainCredential, type SmtpCredentials } from "./smtp.client"
import type { SmtpMessage } from "./smtp.message"

const message: SmtpMessage = {
	id: "dlv_abc123",
	from: "alerts@example.com",
	to: ["on-call@example.com"],
	subject: "steve-bot left the server",
	text: "It has not come back on its own.",
	at: new Date("2026-09-07T12:00:00Z"),
}

const credentials: SmtpCredentials = {
	hostname: HOSTNAME,
	port: 587,
	username: "alerts",
	password: "s3cret",
}

let fake: Fake | undefined

const run = async (
	greeting: string,
	answer: (line: string) => Answer,
	overrides: Partial<SmtpCredentials> = {},
	finalReply?: string,
) => {
	fake = await startFake(greeting, answer, serverSideTls, {
		...(finalReply === undefined ? {} : { finalReply }),
	})
	const socket = await dial(fake.port)
	const conversation = await converse(socket, { ...credentials, ...overrides }, message, {
		upgrade: clientUpgrade,
		timeoutMs: 5000,
	})
	return {
		outcome: conversation.outcome,
		conversation,
		transcript: fake.transcript,
		payload: fake.payload(),
	}
}

const headerLine = (payload: string | undefined, name: string): string | undefined =>
	payload?.split("\r\n").find((line) => line.startsWith(`${name}:`))

afterEach(async () => {
	await fake?.close()
	fake = undefined
})

describe("a delivery that works", () => {
	it("secures the session before signing in, then sends the message", async () => {
		const { outcome, transcript } = await run("220 mail.example.com ESMTP\r\n", happyPath)

		expect(outcome).toEqual({ kind: "delivered", statusCode: 250 })
		expect(transcript.filter((line) => line.startsWith("AUTH"))).toHaveLength(1)
		expect(transcript.indexOf("STARTTLS")).toBeLessThan(
			transcript.findIndex((line) => line.startsWith("AUTH")),
		)
		expect(transcript).toContain("<message>")
		expect(transcript.filter((line) => line.startsWith("EHLO"))).toHaveLength(2)
	})

	it("puts the password nowhere except the AUTH line", async () => {
		const { transcript } = await run("220 mail.example.com ESMTP\r\n", happyPath)
		const authLines = transcript.filter((line) => line.startsWith("AUTH"))
		for (const line of transcript.filter((entry) => !entry.startsWith("AUTH"))) {
			expect(line).not.toContain("s3cret")
		}
		expect(authLines[0]).not.toContain("s3cret")
	})
})

describe("the STARTTLS boundary", () => {
	it("abandons the attempt when bytes arrive alongside the go-ahead", async () => {
		const { outcome, transcript } = await run("220 mail.example.com ESMTP\r\n", (line) => {
			const command = line.toUpperCase()
			if (command.startsWith("EHLO")) return { write: EHLO_WITH_TLS }
			if (command.startsWith("STARTTLS")) {
				return { write: "220 go ahead\r\n250 injected\r\n" }
			}
			return { write: "500 unknown\r\n" }
		})

		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.reason).toBe(
			"That mail server's reply looked tampered with",
		)
		expect(transcript.some((line) => line.startsWith("AUTH"))).toBe(false)
		expect(transcript).not.toContain("<message>")
	})

	it("refuses to carry on when the server will not offer STARTTLS", async () => {
		const { outcome, transcript } = await run("220 mail.example.com ESMTP\r\n", (line) =>
			line.toUpperCase().startsWith("EHLO") ? { write: EHLO_NO_TLS } : { write: "500 unknown\r\n" },
		)

		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.reason).toBe(
			"That mail server would not start a secure session",
		)
		expect(transcript.some((line) => line.startsWith("AUTH"))).toBe(false)
		expect(transcript.some((line) => line.startsWith("MAIL FROM"))).toBe(false)
	})

	it("skips STARTTLS entirely on the implicit-TLS port", async () => {
		const { outcome, transcript } = await run(
			"220 mail.example.com ESMTP\r\n",
			(line) => {
				const command = line.toUpperCase()
				if (command.startsWith("EHLO")) return { write: EHLO_NO_TLS }
				if (command.startsWith("AUTH")) return { write: "235 authenticated\r\n" }
				if (command.startsWith("MAIL FROM")) return { write: "250 sender ok\r\n" }
				if (command.startsWith("RCPT TO")) return { write: "250 recipient ok\r\n" }
				if (command.startsWith("DATA")) return { write: "354 go ahead\r\n" }
				if (command.startsWith("QUIT")) return { write: "221 bye\r\n" }
				return { write: "500 unknown\r\n" }
			},
			{ port: 465 },
		)

		expect(outcome.kind).toBe("delivered")
		expect(transcript).not.toContain("STARTTLS")
		expect(transcript.filter((line) => line.startsWith("EHLO"))).toHaveLength(1)
	})
})

describe("reading refusals the way a server actually sends them", () => {
	it("classifies off the last line of a multi-line reply", async () => {
		const { outcome } = await run("220 mail.example.com ESMTP\r\n", (line) => {
			const command = line.toUpperCase()
			if (command.startsWith("EHLO")) return { write: EHLO_WITH_TLS }
			if (command.startsWith("STARTTLS")) return { write: "220 go ahead\r\n", upgrade: true }
			if (command.startsWith("AUTH")) return { write: "235 authenticated\r\n" }
			if (command.startsWith("MAIL FROM")) {
				return { write: "550-we looked you up\r\n550 and refused you\r\n" }
			}
			return { write: "500 unknown\r\n" }
		})

		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.statusCode).toBe(550)
	})

	it("treats a temporary greeting failure as worth retrying", async () => {
		const { outcome } = await run("421 too busy right now\r\n", happyPath)
		expect(outcome.kind).toBe("retryable")
		expect(outcome.kind === "retryable" && outcome.statusCode).toBe(421)
	})

	it("never asks for a delay, because SMTP has no way to state one", async () => {
		const { outcome } = await run("421 too busy right now\r\n", happyPath)
		expect(outcome.kind === "retryable" && outcome.retryAfterSeconds).toBeUndefined()
	})
})

describe("a recipient the server will not take", () => {
	const withRecipients = (codes: readonly string[]) => {
		let seen = 0
		return (line: string): Answer => {
			const command = line.toUpperCase()
			if (command.startsWith("EHLO")) return { write: EHLO_WITH_TLS }
			if (command.startsWith("STARTTLS")) return { write: "220 go ahead\r\n", upgrade: true }
			if (command.startsWith("AUTH")) return { write: "235 authenticated\r\n" }
			if (command.startsWith("MAIL FROM")) return { write: "250 sender ok\r\n" }
			if (command.startsWith("RCPT TO")) {
				const code = codes[seen] ?? "250 recipient ok"
				seen += 1
				return { write: `${code}\r\n` }
			}
			if (command.startsWith("DATA")) return { write: "354 go ahead\r\n" }
			return { write: "500 unknown\r\n" }
		}
	}

	const many: SmtpMessage = {
		...message,
		to: ["first@example.com", "second@example.com"],
	}

	const runWith = async (
		codes: readonly string[],
		finalReply?: string,
		recipients: SmtpMessage = many,
	) => {
		fake = await startFake("220 mail.example.com ESMTP\r\n", withRecipients(codes), serverSideTls, {
			...(finalReply === undefined ? {} : { finalReply }),
		})
		const socket = await dial(fake.port)
		const conversation = await converse(socket, credentials, recipients, {
			upgrade: clientUpgrade,
			timeoutMs: 5000,
		})
		return {
			outcome: conversation.outcome,
			conversation,
			transcript: fake.transcript,
			payload: fake.payload(),
		}
	}

	const three: SmtpMessage = {
		...message,
		to: ["first@example.com", "second@example.com", "third@example.com"],
	}

	it("still sends to the addresses it accepted, and settles terminal without retrying", async () => {
		const { outcome, conversation, transcript, payload } = await runWith([
			"250 ok",
			"550 no such mailbox",
		])

		expect(transcript).toContain("<message>")
		expect(conversation.kind).toBe("settled")
		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.statusCode).toBe(550)
		expect(outcome.kind === "terminal" && outcome.stopSending).toBe(false)
		expect(headerLine(payload, "To")).toBe("To: first@example.com, second@example.com")
	})

	it("names no address in the reason an operator sees", async () => {
		const { outcome } = await runWith(["250 ok", "550 no such mailbox"])

		const reason = outcome.kind === "delivered" ? "" : outcome.reason
		expect(reason).toBe("That mail server refused one or more of the addresses")
		for (const address of many.to) expect(reason).not.toContain(address)
	})

	it("carries the first transient refusal when a partial send met only transient ones", async () => {
		const { outcome, transcript } = await runWith(
			["250 ok", "450 try later", "451 also later"],
			undefined,
			three,
		)

		expect(transcript).toContain("<message>")
		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.statusCode).toBe(450)
	})

	it("prefers the permanent refusal over an earlier transient one on a partial send", async () => {
		const { outcome, transcript } = await runWith(
			["250 ok", "450 try later", "550 gone"],
			undefined,
			three,
		)

		expect(
			transcript,
			"without this the old abort-before-DATA behaviour returns the same 550",
		).toContain("<message>")
		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.statusCode).toBe(550)
	})

	it("lets a transient reply after the dot override the partial result entirely", async () => {
		const { conversation } = await runWith(["250 ok", "550 gone"], "451 spooling failed\r\n")

		expect(conversation.kind).toBe("tryNextAddress")
		expect(conversation.outcome.kind).toBe("retryable")
		expect(conversation.outcome.statusCode).toBe(451)
	})

	it("lets a permanent reply after the dot override the partial result entirely", async () => {
		const { conversation } = await runWith(["250 ok", "550 gone"], "552 mailbox full\r\n")

		expect(conversation.kind).toBe("settled")
		expect(conversation.outcome.kind).toBe("terminal")
		expect(conversation.outcome.statusCode).toBe(552)
	})

	it("settles delivered when every address is accepted", async () => {
		const { outcome } = await runWith(["250 ok", "250 ok"])

		expect(outcome.kind).toBe("delivered")
	})

	it("with nothing accepted, prefers the permanent refusal over an earlier transient one", async () => {
		const { outcome } = await runWith(["450 try later", "550 no such mailbox"])
		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.statusCode).toBe(550)
	})

	it("with nothing accepted, retries only when every refusal was temporary", async () => {
		const { outcome, transcript } = await runWith(["450 try later", "451 also later"])

		expect(outcome.kind).toBe("retryable")
		expect(outcome.kind === "retryable" && outcome.statusCode).toBe(450)
		expect(transcript).not.toContain("DATA")
	})
})

describe("the AUTH PLAIN payload", () => {
	it("separates the parts with NUL bytes, as the mechanism requires", () => {
		const encoded = plainCredential("alerts", "s3cret")
		expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("\0alerts\0s3cret")
	})
})

describe("whether a conversation says another address is worth trying", () => {
	const answering =
		(overrides: Readonly<Record<string, string>>) =>
		(line: string): Answer => {
			const command = line.toUpperCase()
			for (const [prefix, reply] of Object.entries(overrides)) {
				if (command.startsWith(prefix)) return { write: reply }
			}
			return happyPath(line)
		}

	it("says try the next address on a transient reply before any data is written", async () => {
		const { conversation, transcript } = await run(
			"220 mail.example.com ESMTP\r\n",
			answering({ "MAIL FROM": "450 mailbox busy, try later\r\n" }),
		)

		expect(conversation.kind).toBe("tryNextAddress")
		expect(transcript.some((line) => line.startsWith("DATA"))).toBe(false)
	})

	it("settles on a permanent reply before any data is written", async () => {
		const { conversation, transcript } = await run(
			"220 mail.example.com ESMTP\r\n",
			answering({ "MAIL FROM": "550 sender rejected\r\n" }),
		)

		expect(conversation.kind).toBe("settled")
		expect(transcript.some((line) => line.startsWith("DATA"))).toBe(false)
	})

	it("says try the next address when DATA is refused transiently, since nothing was sent", async () => {
		const { conversation } = await run(
			"220 mail.example.com ESMTP\r\n",
			answering({ DATA: "451 not now\r\n" }),
		)

		expect(conversation.kind).toBe("tryNextAddress")
	})

	it("settles when the server refuses DATA permanently", async () => {
		const { conversation } = await run(
			"220 mail.example.com ESMTP\r\n",
			answering({ DATA: "554 no\r\n" }),
		)

		expect(conversation.kind).toBe("settled")
	})

	it("says try the next address on an explicit transient reply after the terminating dot", async () => {
		const { conversation, transcript } = await run(
			"220 mail.example.com ESMTP\r\n",
			happyPath,
			{},
			"451 spooling failed, retry\r\n",
		)

		expect(conversation.kind).toBe("tryNextAddress")
		expect(conversation.outcome.kind).toBe("retryable")
		expect(transcript).toContain("<message>")
	})

	it("settles on an explicit permanent reply after the terminating dot", async () => {
		const { conversation, transcript } = await run(
			"220 mail.example.com ESMTP\r\n",
			happyPath,
			{},
			"552 mailbox full\r\n",
		)

		expect(conversation.kind).toBe("settled")
		expect(conversation.outcome.kind).toBe("terminal")
		expect(transcript).toContain("<message>")
	})

	it("says try the next address when the secure upgrade itself fails", async () => {
		fake = await startFake("220 mail.example.com ESMTP\r\n", happyPath, serverSideTls)
		const socket = await dial(fake.port)
		const conversation = await converse(socket, credentials, message, {
			upgrade: async () => {
				throw new Error("the handshake failed")
			},
			timeoutMs: 5000,
		})

		expect(conversation.kind).toBe("tryNextAddress")
	})

	it("says try the next address when the connection dies waiting for the go-ahead", async () => {
		const { conversation, transcript } = await run("220 mail.example.com ESMTP\r\n", (line) =>
			line.toUpperCase().startsWith("DATA") ? { drop: true } : happyPath(line),
		)

		expect(transcript.some((line) => line.startsWith("DATA"))).toBe(true)
		expect(transcript).not.toContain("<message>")
		expect(conversation.kind).toBe("tryNextAddress")
	})

	it("says try the next address when the connection dies after a recipient was accepted", async () => {
		let asked = 0
		fake = await startFake(
			"220 mail.example.com ESMTP\r\n",
			(line) => {
				if (line.toUpperCase().startsWith("RCPT TO")) {
					asked += 1
					return asked === 1 ? { write: "250 recipient ok\r\n" } : { drop: true }
				}
				return happyPath(line)
			},
			serverSideTls,
		)
		const socket = await dial(fake.port)
		const conversation = await converse(
			socket,
			credentials,
			{ ...message, to: ["first@example.com", "second@example.com"] },
			{ upgrade: clientUpgrade, timeoutMs: 5000 },
		)

		expect(asked).toBe(2)
		expect(conversation.kind).toBe("tryNextAddress")
	})

	it("settles rather than failing over when the connection dies mid-payload", async () => {
		fake = await startFake("220 mail.example.com ESMTP\r\n", happyPath, serverSideTls, {
			dropAtPayload: true,
		})
		const socket = await dial(fake.port)
		const conversation = await converse(socket, credentials, message, {
			upgrade: clientUpgrade,
			timeoutMs: 5000,
		})

		expect(fake.transcript).toContain("<dropped>")
		expect(
			conversation.kind,
			"the payload was already on the wire, so retrying elsewhere risks a duplicate",
		).toBe("settled")
	})

	it("stays delivered when the message is accepted but QUIT cannot be sent", async () => {
		fake = await startFake("220 mail.example.com ESMTP\r\n", happyPath, serverSideTls)
		const socket = await dial(fake.port)
		const conversation = await converse(socket, credentials, message, {
			upgrade: async (plain) => {
				const secure = await clientUpgrade(plain)
				let seen = ""
				secure.on("data", (chunk: Buffer) => {
					seen += chunk.toString("utf8")
					if (seen.includes("250 queued")) secure.destroy()
				})
				return secure
			},
			timeoutMs: 5000,
		})

		expect(fake.transcript).toContain("<message>")
		expect(fake.transcript).not.toContain("QUIT")
		expect(conversation.kind).toBe("settled")
		expect(
			conversation.outcome.kind,
			"the server already took the message, so a failed QUIT must not make it retryable",
		).toBe("delivered")
	})

	it("settles as delivered on a positive final reply, and sends the configured recipients", async () => {
		const { conversation, payload } = await run("220 mail.example.com ESMTP\r\n", happyPath)

		expect(conversation.kind).toBe("settled")
		expect(conversation.outcome.kind).toBe("delivered")
		expect(headerLine(payload, "To")).toBe("To: on-call@example.com")
	})

	it("settles when the server does not advertise the STARTTLS we require", async () => {
		const { conversation } = await run(
			"220 mail.example.com ESMTP\r\n",
			answering({ EHLO: "250-mail.example.com\r\n250 PIPELINING\r\n" }),
		)

		expect(conversation.kind).toBe("settled")
	})
})

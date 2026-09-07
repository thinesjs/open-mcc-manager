import { readFileSync } from "node:fs"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { join } from "node:path"
import { connect as startTls, TLSSocket } from "node:tls"
import { afterEach, describe, expect, it } from "vitest"
import { converse, plainCredential, type SmtpCredentials } from "./smtp.client"
import { secureOptions } from "./smtp.connect"
import type { SmtpMessage } from "./smtp.message"

const FIXTURES = join(import.meta.dirname, "fixtures")

const cert = readFileSync(join(FIXTURES, "smtp-test-cert.pem"))
const key = readFileSync(join(FIXTURES, "smtp-test-key.pem"))

const HOSTNAME = "smtp.example.com"

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

type Answer = { readonly write?: string; readonly upgrade?: boolean }

type Fake = {
	readonly port: number
	readonly transcript: readonly string[]
	readonly close: () => Promise<void>
}

const startFake = async (
	greeting: string,
	answer: (line: string) => Answer,
	secureFrom: (socket: Socket) => Socket,
): Promise<Fake> => {
	const transcript: string[] = []
	let server: Server | undefined

	const drive = (socket: Socket) => {
		let buffer = ""
		let collecting = false

		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf8")

			if (collecting) {
				const end = buffer.indexOf("\r\n.\r\n")
				if (end === -1) return
				transcript.push("<message>")
				buffer = buffer.slice(end + 5)
				collecting = false
				socket.write("250 queued\r\n")
			}

			while (true) {
				const end = buffer.indexOf("\r\n")
				if (end === -1) return
				const line = buffer.slice(0, end)
				buffer = buffer.slice(end + 2)
				transcript.push(line)

				const reply = answer(line)
				if (reply.write !== undefined) socket.write(reply.write)
				if (reply.upgrade === true) {
					socket.removeListener("data", onData)
					const secure = secureFrom(socket)
					drive(secure)
					return
				}
				if (line.toUpperCase().startsWith("DATA")) {
					collecting = true
					return
				}
			}
		}

		socket.on("data", onData)
		socket.on("error", () => undefined)
	}

	server = createServer((socket) => {
		socket.write(greeting)
		drive(socket)
	})

	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
	const address = server.address()

	return {
		port: typeof address === "object" && address !== null ? address.port : 0,
		transcript,
		close: () => new Promise<void>((resolve) => server?.close(() => resolve())),
	}
}

const serverSideTls = (socket: Socket): Socket =>
	new TLSSocket(socket, { isServer: true, cert, key })

const clientUpgrade = (socket: Socket) =>
	new Promise<TLSSocket>((resolve, reject) => {
		const secure = startTls({ ...secureOptions(socket, HOSTNAME), ca: [cert] })
		secure.once("secureConnect", () => resolve(secure))
		secure.once("error", reject)
	})

const dial = (port: number): Promise<Socket> =>
	new Promise((resolve, reject) => {
		const socket = createConnection({ host: "127.0.0.1", port })
		socket.once("connect", () => resolve(socket))
		socket.once("error", reject)
	})

const EHLO_WITH_TLS = "250-mail.example.com\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n"

const EHLO_NO_TLS = "250-mail.example.com\r\n250 AUTH PLAIN LOGIN\r\n"

let fake: Fake | undefined

const run = async (
	greeting: string,
	answer: (line: string) => Answer,
	overrides: Partial<SmtpCredentials> = {},
) => {
	fake = await startFake(greeting, answer, serverSideTls)
	const socket = await dial(fake.port)
	const outcome = await converse(socket, { ...credentials, ...overrides }, message, {
		upgrade: clientUpgrade,
		timeoutMs: 5000,
	})
	return { outcome, transcript: fake.transcript }
}

afterEach(async () => {
	await fake?.close()
	fake = undefined
})

const happyPath = (line: string): Answer => {
	const command = line.toUpperCase()
	if (command.startsWith("EHLO")) return { write: EHLO_WITH_TLS }
	if (command.startsWith("STARTTLS")) return { write: "220 go ahead\r\n", upgrade: true }
	if (command.startsWith("AUTH")) return { write: "235 authenticated\r\n" }
	if (command.startsWith("MAIL FROM")) return { write: "250 sender ok\r\n" }
	if (command.startsWith("RCPT TO")) return { write: "250 recipient ok\r\n" }
	if (command.startsWith("DATA")) return { write: "354 go ahead\r\n" }
	if (command.startsWith("QUIT")) return { write: "221 bye\r\n" }
	return { write: "500 unknown\r\n" }
}

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

	const runWith = async (codes: readonly string[]) => {
		fake = await startFake("220 mail.example.com ESMTP\r\n", withRecipients(codes), serverSideTls)
		const socket = await dial(fake.port)
		const outcome = await converse(socket, credentials, many, {
			upgrade: clientUpgrade,
			timeoutMs: 5000,
		})
		return { outcome, transcript: fake.transcript }
	}

	it("gives up permanently when any address is refused for good, and never sends the message", async () => {
		const { outcome, transcript } = await runWith(["250 ok", "550 no such mailbox"])

		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.statusCode).toBe(550)
		expect(transcript).not.toContain("DATA")
		expect(transcript).not.toContain("<message>")
	})

	it("prefers the permanent refusal even when a temporary one came first", async () => {
		const { outcome } = await runWith(["450 try later", "550 no such mailbox"])
		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.statusCode).toBe(550)
	})

	it("retries only when every refusal was temporary", async () => {
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

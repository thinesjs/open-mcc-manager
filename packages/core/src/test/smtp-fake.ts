import { readFileSync } from "node:fs"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { join } from "node:path"
import { connect as startTls, TLSSocket } from "node:tls"
import { secureOptions } from "../notification/smtp.connect"

const FIXTURES = join(import.meta.dirname, "..", "notification", "fixtures")

export const cert = readFileSync(join(FIXTURES, "smtp-test-cert.pem"))

const key = readFileSync(join(FIXTURES, "smtp-test-key.pem"))

export const HOSTNAME = "smtp.example.com"

export const EHLO_WITH_TLS = "250-mail.example.com\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n"

export const EHLO_NO_TLS = "250-mail.example.com\r\n250 AUTH PLAIN LOGIN\r\n"

export type Answer = {
	readonly write?: string
	readonly upgrade?: boolean
	readonly drop?: boolean
}

export type Fake = {
	readonly port: number
	readonly transcript: readonly string[]
	readonly close: () => Promise<void>
}

export type FakeOptions = {
	readonly finalReply?: string
	readonly dropAtPayload?: boolean
}

export const startFake = async (
	greeting: string,
	answer: (line: string) => Answer,
	secureFrom: (socket: Socket) => Socket,
	options: FakeOptions = {},
): Promise<Fake> => {
	const finalReply = options.finalReply ?? "250 queued\r\n"
	const transcript: string[] = []
	let server: Server | undefined

	const drive = (socket: Socket) => {
		let buffer = ""
		let collecting = false

		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf8")

			if (collecting) {
				if (options.dropAtPayload === true) {
					transcript.push("<dropped>")
					socket.destroy()
					return
				}
				const end = buffer.indexOf("\r\n.\r\n")
				if (end === -1) return
				transcript.push("<message>")
				buffer = buffer.slice(end + 5)
				collecting = false
				socket.write(finalReply)
			}

			while (true) {
				const end = buffer.indexOf("\r\n")
				if (end === -1) return
				const line = buffer.slice(0, end)
				buffer = buffer.slice(end + 2)
				transcript.push(line)

				const reply = answer(line)
				if (reply.write !== undefined) socket.write(reply.write)
				if (reply.drop === true) {
					transcript.push("<dropped>")
					socket.destroy()
					return
				}
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

export const serverSideTls = (socket: Socket): Socket =>
	new TLSSocket(socket, { isServer: true, cert, key })

export const clientUpgrade = (socket: Socket): Promise<TLSSocket> =>
	new Promise<TLSSocket>((resolve, reject) => {
		const secure = startTls({ ...secureOptions(socket, HOSTNAME), ca: [cert] })
		secure.once("secureConnect", () => resolve(secure))
		secure.once("error", reject)
	})

export const dial = (port: number): Promise<Socket> =>
	new Promise((resolve, reject) => {
		const socket = createConnection({ host: "127.0.0.1", port })
		socket.once("connect", () => resolve(socket))
		socket.once("error", reject)
	})

export const happyPath = (line: string): Answer => {
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

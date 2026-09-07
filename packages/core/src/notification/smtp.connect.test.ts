import { readFileSync } from "node:fs"
import { createConnection } from "node:net"
import { join } from "node:path"
import { createServer as createTlsServer, connect as startTls, type TLSSocket } from "node:tls"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { needsStartTls, openPinned, secureOptions } from "./smtp.connect"

const FIXTURES = join(import.meta.dirname, "fixtures")

const cert = readFileSync(join(FIXTURES, "smtp-test-cert.pem"))
const key = readFileSync(join(FIXTURES, "smtp-test-key.pem"))

const HOSTNAME = "smtp.example.com"

const server = createTlsServer({ cert, key }, (socket) => socket.end())

let port = 0

const handshake = (servername: string | undefined): Promise<TLSSocket> =>
	new Promise((resolve, reject) => {
		const plain = createConnection({ host: "127.0.0.1", port })
		plain.once("connect", () => {
			const secure = startTls({
				...secureOptions(plain, HOSTNAME),
				ca: [cert],
				...(servername === undefined ? { servername: undefined } : { servername }),
			})
			secure.once("secureConnect", () => resolve(secure))
			secure.once("error", (error) => reject(error))
		})
		plain.once("error", (error) => reject(error))
	})

beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	port = typeof address === "object" && address !== null ? address.port : 0
})

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe("the options that decide who we trust", () => {
	it("verifies against the configured hostname, never the address we dialled", () => {
		const socket = createConnection({ host: "127.0.0.1", port })
		const options = secureOptions(socket, HOSTNAME)

		expect("servername" in options && options.servername).toBe(HOSTNAME)
		expect("servername" in options && options.servername).not.toBe("127.0.0.1")
		expect("host" in options).toBe(false)
		expect(options.rejectUnauthorized).toBe(true)
		expect(options.socket).toBe(socket)
		socket.destroy()
	})

	it("leaves no way to turn verification off", () => {
		const socket = createConnection({ host: "127.0.0.1", port })
		expect(Object.keys(secureOptions(socket, HOSTNAME)).sort()).toEqual([
			"rejectUnauthorized",
			"servername",
			"socket",
		])
		socket.destroy()
	})

	it("names a literal address as the host, because SNI may not carry one", () => {
		const socket = createConnection({ host: "127.0.0.1", port })
		const options = secureOptions(socket, "192.168.4.9")

		expect(Object.keys(options).sort()).toEqual(["host", "rejectUnauthorized", "socket"])
		expect("servername" in options).toBe(false)
		expect(options.rejectUnauthorized).toBe(true)
		socket.destroy()
	})

	it("still uses SNI for a name, and both for an IPv6 literal", () => {
		const socket = createConnection({ host: "127.0.0.1", port })
		expect("servername" in secureOptions(socket, "mail.example.com")).toBe(true)
		expect("host" in secureOptions(socket, "2001:db8::1")).toBe(true)
		socket.destroy()
	})
})

describe("a real handshake over a socket that is already connected", () => {
	it("accepts a certificate whose name matches the hostname we asked for", async () => {
		const secure = await handshake(HOSTNAME)
		expect(secure.authorized).toBe(true)
		secure.destroy()
	})

	it("refuses the same server when the hostname is not carried over", async () => {
		await expect(handshake(undefined)).rejects.toThrow(/127\.0\.0\.1|altnames|IP address/i)
	})

	it("refuses a certificate that does not name the host we asked for", async () => {
		await expect(handshake("not-the-server.example.com")).rejects.toThrow(/altnames|Hostname/i)
	})
})

describe("which port means which kind of TLS", () => {
	it("goes straight to TLS on 465 and demands STARTTLS everywhere else", () => {
		expect(needsStartTls(465)).toBe(false)
		expect(needsStartTls(587)).toBe(true)
		expect(needsStartTls(25)).toBe(true)
		expect(needsStartTls(2525)).toBe(true)
	})
})

describe("opening the pinned socket", () => {
	it("dials the address it was given", async () => {
		const socket = await openPinned({ address: "127.0.0.1", port, timeoutMs: 5000 })
		expect(socket.remoteAddress).toBe("127.0.0.1")
		socket.destroy()
	})

	it("gives up rather than hanging when nothing answers", async () => {
		await expect(openPinned({ address: "192.0.2.1", port: 25, timeoutMs: 150 })).rejects.toThrow()
	})
})

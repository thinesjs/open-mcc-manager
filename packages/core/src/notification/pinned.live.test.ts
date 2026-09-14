import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { DELIVERY_MAX_RESPONSE_BYTES } from "@open-mcc/contracts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { egressPolicy } from "./egress"
import { sendPinned } from "./pinned"

type Received = { method: string; url: string; headers: Record<string, string>; body: string }

let server: Server
let port = 0
const received: Received[] = []
let reply: { status: number; headers: Record<string, string>; body: string } = {
	status: 200,
	headers: {},
	body: "ok",
}

beforeAll(
	async () =>
		await new Promise<void>((resolve) => {
			server = createServer((request, response) => {
				const chunks: Buffer[] = []
				request.on("data", (chunk: Buffer) => chunks.push(chunk))
				request.on("end", () => {
					const headers: Record<string, string> = {}
					for (const [key, value] of Object.entries(request.headers)) {
						if (typeof value === "string") headers[key] = value
					}
					received.push({
						method: request.method ?? "",
						url: request.url ?? "",
						headers,
						body: Buffer.concat(chunks).toString("utf8"),
					})
					response.writeHead(reply.status, reply.headers)
					response.end(reply.body)
				})
			})
			server.listen(0, "127.0.0.1", () => {
				const address = server.address()
				port =
					address !== null && typeof address === "object" ? (address satisfies AddressInfo).port : 0
				resolve()
			})
		}),
)

afterAll(
	async () =>
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()))
		}),
)

const localPolicy = egressPolicy({
	allowHttp: true,
	allowedHosts: "",
	allowedAddresses: "127.0.0.1",
})

const namedHostPolicy = egressPolicy({
	allowHttp: true,
	allowedHosts: "push.internal",
	allowedAddresses: "127.0.0.1",
})

describe("a real request through the pinned dispatcher", () => {
	it("reaches the server and comes back", async () => {
		received.length = 0
		reply = { status: 200, headers: { "content-type": "text/plain" }, body: "thanks" }

		const result = await sendPinned({
			url: `http://127.0.0.1:${port}/hook`,
			method: "POST",
			headers: { "content-type": "application/json", "webhook-id": "ntf_1" },
			body: '{"hello":"world"}',
			policy: localPolicy,
		})

		expect(result.sent).toBe(true)
		expect(result.sent === true && result.status).toBe(200)
		expect(result.sent === true && result.body).toBe("thanks")
		expect(result.sent === true && result.headers["content-type"]).toBe("text/plain")
	})

	it("sends the method, path, headers and body the caller asked for", () => {
		expect(received[0]?.method).toBe("POST")
		expect(received[0]?.url).toBe("/hook")
		expect(received[0]?.headers["webhook-id"]).toBe("ntf_1")
		expect(received[0]?.body).toBe('{"hello":"world"}')
	})

	it("keeps the name the caller used in the Host header, not the address it was pinned to", async () => {
		received.length = 0
		reply = { status: 200, headers: {}, body: "ok" }

		const result = await sendPinned({
			url: `http://push.internal:${port}/hook`,
			method: "POST",
			headers: {},
			body: "{}",
			policy: namedHostPolicy,
			lookupAddresses: async () => [{ address: "127.0.0.1", family: 4 }],
		})

		expect(result.sent).toBe(true)
		expect(received[0]?.headers.host).toBe(`push.internal:${port}`)
	})

	it("does not follow a redirect, it reports it", async () => {
		received.length = 0
		reply = { status: 302, headers: { location: "http://169.254.169.254/latest" }, body: "" }

		const result = await sendPinned({
			url: `http://127.0.0.1:${port}/hook`,
			method: "POST",
			headers: {},
			body: "{}",
			policy: localPolicy,
		})

		expect(result.sent === true && result.status).toBe(302)
		expect(received).toHaveLength(1)
	})

	it("refuses the same server when its address was never named", async () => {
		received.length = 0
		const result = await sendPinned({
			url: `http://127.0.0.1:${port}/hook`,
			method: "POST",
			headers: {},
			body: "{}",
			policy: egressPolicy({ allowHttp: true, allowedHosts: "", allowedAddresses: "" }),
		})

		expect(result.sent).toBe(false)
		expect(received).toHaveLength(0)
	})

	it("refuses plain http to a named address when http was never turned on", async () => {
		received.length = 0
		const result = await sendPinned({
			url: `http://127.0.0.1:${port}/hook`,
			method: "POST",
			headers: {},
			body: "{}",
			policy: egressPolicy({
				allowHttp: false,
				allowedHosts: "",
				allowedAddresses: "127.0.0.1",
			}),
		})

		expect(result.sent).toBe(false)
		expect(received).toHaveLength(0)
	})

	it("reads a larger answer when the caller allows one", async () => {
		reply = { status: 200, headers: {}, body: "x".repeat(200 * 1024) }

		const result = await sendPinned({
			url: `http://127.0.0.1:${port}/release`,
			method: "GET",
			headers: {},
			policy: localPolicy,
			maxResponseBytes: 1024 * 1024,
		})

		expect(result.sent === true && result.body.length).toBe(200 * 1024)
	})

	it("keeps a delivery's answer within the notification limit when the caller names none", async () => {
		reply = { status: 200, headers: {}, body: "x".repeat(DELIVERY_MAX_RESPONSE_BYTES + 1) }

		await expect(
			sendPinned({
				url: `http://127.0.0.1:${port}/hook`,
				method: "POST",
				headers: {},
				body: "{}",
				policy: localPolicy,
			}),
		).rejects.toThrow()
	})

	it("gives up rather than hanging when the server never answers", async () => {
		reply = { status: 200, headers: {}, body: "ok" }
		const stalling = createServer(() => {})
		await new Promise<void>((resolve) => stalling.listen(0, "127.0.0.1", () => resolve()))
		const address = stalling.address()
		const stallingPort =
			address !== null && typeof address === "object" ? (address satisfies AddressInfo).port : 0

		try {
			await expect(
				sendPinned({
					url: `http://127.0.0.1:${stallingPort}/hook`,
					method: "POST",
					headers: {},
					body: "{}",
					timeoutMs: 300,
					policy: localPolicy,
				}),
			).rejects.toThrow()
		} finally {
			await new Promise<void>((resolve) => stalling.close(() => resolve()))
		}
	})
})

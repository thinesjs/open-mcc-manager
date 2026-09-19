import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	clientDownloadCommand,
	DOWNLOAD_ATTEMPTS,
	DOWNLOAD_FIRST_BACKOFF_SECONDS,
} from "./provision"

const PAYLOAD = "the minecraft console client"

type Answer = (hit: number, request: IncomingMessage, response: ServerResponse) => void

type Origin = { url: string; hits: () => number; close: () => Promise<void> }

const origins: Origin[] = []
const scratches: string[] = []

afterEach(async () => {
	for (const origin of origins.splice(0)) await origin.close()
	for (const scratch of scratches.splice(0)) rmSync(scratch, { force: true, recursive: true })
})

const addressOf = (server: Server): AddressInfo => {
	const address = server.address()
	if (address === null || typeof address === "string") {
		throw new Error("the stand-in origin did not listen on a port")
	}
	return address
}

const origin = async (answer: Answer): Promise<Origin> => {
	let hits = 0
	const sockets = new Set<Socket>()
	const server = createServer((request, response) => {
		hits += 1
		answer(hits, request, response)
	})
	server.on("connection", (socket) => {
		sockets.add(socket)
		socket.on("close", () => sockets.delete(socket))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const started = {
		url: `http://127.0.0.1:${addressOf(server).port}/MinecraftClient-linux-x64`,
		hits: () => hits,
		close: async () => {
			for (const socket of sockets) socket.destroy()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		},
	}
	origins.push(started)
	return started
}

const serve = (response: ServerResponse, status: number, body: string): void => {
	response.writeHead(status, { "content-type": "application/octet-stream" })
	response.end(body)
}

const cutShort = (response: ServerResponse): void => {
	response.writeHead(200, { "content-length": String(PAYLOAD.length + 64) })
	response.write(PAYLOAD.slice(0, 5), () => response.socket?.destroy())
}

type Ran = { status: number | null; stdout: string; stderr: string; tookMs: number }

const download = async (url: string): Promise<Ran> => {
	const scratch = mkdtempSync(join(tmpdir(), "client-download-"))
	scratches.push(scratch)
	const began = Date.now()
	const child = spawn("/bin/sh", ["-c", clientDownloadCommand(url)], {
		env: { ...process.env, TMPDIR: scratch },
	})
	let stdout = ""
	let stderr = ""
	child.stdout.setEncoding("utf8")
	child.stderr.setEncoding("utf8")
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk
	})
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk
	})
	const status = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject)
		child.on("close", resolve)
	})
	return { status, stdout, stderr, tookMs: Date.now() - began }
}

const fetched = (ran: Ran): string => readFileSync(`${ran.stdout}/mcc`, "utf8")

const BACKOFF_MS = DOWNLOAD_FIRST_BACKOFF_SECONDS * 1000

const BACKED_OFF_TWICE_MS = BACKOFF_MS + BACKOFF_MS * 2

const RETRYING_DEADLINE_MS = 30_000

describe("the command that downloads the client", () => {
	it(
		"retries a 500 and installs what the retry returned, rather than failing the provision",
		async () => {
			const server = await origin((hit, _request, response) => {
				if (hit <= 2) serve(response, 500, "internal server error")
				else serve(response, 200, PAYLOAD)
			})

			const ran = await download(server.url)

			expect(ran.status, ran.stderr).toBe(0)
			expect(fetched(ran)).toBe(PAYLOAD)
			expect(server.hits()).toBe(3)
		},
		RETRYING_DEADLINE_MS,
	)

	it(
		"retries a connection the origin reset, which curl's own --retry leaves alone",
		async () => {
			const server = await origin((hit, request, response) => {
				if (hit <= 1) request.socket.destroy()
				else serve(response, 200, PAYLOAD)
			})

			const ran = await download(server.url)

			expect(ran.status, ran.stderr).toBe(0)
			expect(fetched(ran)).toBe(PAYLOAD)
			expect(server.hits()).toBe(2)
		},
		RETRYING_DEADLINE_MS,
	)

	it(
		"retries a body the origin cut short rather than leaving the truncated file for the checksum",
		async () => {
			const server = await origin((hit, _request, response) => {
				if (hit <= 1) cutShort(response)
				else serve(response, 200, PAYLOAD)
			})

			const ran = await download(server.url)

			expect(ran.status, ran.stderr).toBe(0)
			expect(fetched(ran)).toBe(PAYLOAD)
			expect(server.hits()).toBe(2)
		},
		RETRYING_DEADLINE_MS,
	)

	it(
		"waits longer before each retry, so an origin already in trouble is not hammered",
		async () => {
			const server = await origin((hit, _request, response) => {
				if (hit <= 2) serve(response, 503, "service unavailable")
				else serve(response, 200, PAYLOAD)
			})

			const ran = await download(server.url)

			expect(ran.status, ran.stderr).toBe(0)
			expect(ran.tookMs).toBeGreaterThanOrEqual(BACKED_OFF_TWICE_MS)
		},
		RETRYING_DEADLINE_MS,
	)

	it("fails on a 404 at the first answer, without a second request and without a backoff", async () => {
		const server = await origin((_hit, _request, response) => serve(response, 404, "not found"))

		const ran = await download(server.url)

		expect(ran.status).not.toBe(0)
		expect(server.hits()).toBe(1)
		expect(ran.tookMs).toBeLessThan(BACKOFF_MS)
		expect(ran.stderr).toContain("404")
	})

	it("fails on a 403 at the first answer too, so an artefact no key can reach stays a fast failure", async () => {
		const server = await origin((_hit, _request, response) => serve(response, 403, "forbidden"))

		const ran = await download(server.url)

		expect(ran.status).not.toBe(0)
		expect(server.hits()).toBe(1)
		expect(ran.tookMs).toBeLessThan(BACKOFF_MS)
	})

	it(
		"gives a 500 that never clears a bounded number of attempts rather than retrying to its deadline",
		async () => {
			const server = await origin((_hit, _request, response) =>
				serve(response, 500, "internal server error"),
			)

			const ran = await download(server.url)

			expect(ran.status).not.toBe(0)
			expect(server.hits()).toBe(DOWNLOAD_ATTEMPTS)
		},
		RETRYING_DEADLINE_MS,
	)

	it("prints the directory it downloaded into and nothing else, so the caller can verify and install", async () => {
		const server = await origin((_hit, _request, response) => serve(response, 200, PAYLOAD))

		const ran = await download(server.url)

		expect(ran.status, ran.stderr).toBe(0)
		expect(ran.stdout).toMatch(/^\S+$/)
		expect(server.hits()).toBe(1)
		expect(fetched(ran)).toBe(PAYLOAD)
	})
})

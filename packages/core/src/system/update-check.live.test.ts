import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { egressPolicy } from "../notification/egress"
import { createUpdateCheck, requestRelease } from "./update-check"
import type { UpdateCheckResult } from "./update-state.repository"

const LATEST = "/repos/thinesjs/open-mcc-manager/releases/latest"
const MOVED_TO = "/repositories/1/releases/latest"

type Reply = { status: number; headers: Record<string, string>; body: string }

let server: Server
let port = 0
const received: string[] = []
let reply: Reply = { status: 200, headers: {}, body: "" }

const releaseBody = (notes: string) => JSON.stringify({ tag_name: "v1.5.0", body: notes })

beforeAll(
	async () =>
		await new Promise<void>((resolve) => {
			server = createServer((request, response) => {
				received.push(request.url ?? "")
				if (request.url === MOVED_TO) {
					response.writeHead(200, { "content-type": "application/json" })
					response.end(releaseBody("followed"))
					return
				}
				response.writeHead(reply.status, reply.headers)
				response.end(reply.body)
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

const checkAgainstLocalServer = async (): Promise<UpdateCheckResult[]> => {
	received.length = 0
	const results: UpdateCheckResult[] = []
	const check = createUpdateCheck({
		build: { version: "1.4.0", commit: "abc123def456" },
		readState: async () => undefined,
		request: async () =>
			await requestRelease(`http://127.0.0.1:${port}${LATEST}`, { policy: localPolicy }),
		record: async (_source, _checkedAt, result) => {
			results.push(result)
		},
		now: () => new Date("2026-09-13T12:41:00Z"),
	})
	await check()
	return results
}

describe("a real release check through the pinned dispatcher", () => {
	it("reads a release whose answer is larger than a notification reply may be", async () => {
		reply = { status: 200, headers: {}, body: releaseBody("x".repeat(200 * 1024)) }

		const [result] = await checkAgainstLocalServer()

		expect(result?.outcome).toBe("ok")
		expect(result?.outcome === "ok" && result.release.version).toBe("1.5.0")
		expect(result?.outcome === "ok" && result.release.notesTruncated).toBe(true)
	})

	it("refuses an answer past its own limit rather than reading part of it", async () => {
		reply = { status: 200, headers: {}, body: releaseBody("x".repeat(2 * 1024 * 1024)) }

		expect(await checkAgainstLocalServer()).toEqual([{ outcome: "unreadable" }])
	})

	it("reports a moved repository as not found and never follows it", async () => {
		reply = { status: 301, headers: { location: `http://127.0.0.1:${port}${MOVED_TO}` }, body: "" }

		expect(await checkAgainstLocalServer()).toEqual([{ outcome: "not-found" }])
		expect(received).toEqual([LATEST])
	})
})

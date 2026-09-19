import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
import { Server as SshServer } from "ssh2"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ChannelQueueExpiredError, CommandTimedOutError } from "../errors"
import { createSshTransport } from "./connection"
import { DEFAULT_EXEC_CONCURRENCY } from "./limiter"

const SPAWN_TIMEOUT_MS = 60_000

const HOLD_COMMAND = "hold"

const BRIEF_COMMAND = "brief"

const BRIEF_HOLD_MS = 1_000

const HOLD_TIMEOUT_MS = 30_000

const QUEUE_TIMEOUT_MS = 250

const WATCHDOG_MS = 3_000

const BEHIND_BRIEF_TIMEOUT_MS = 1_500

const BEHIND_BRIEF_CEILING_MS = 2_000

const TEST_TIMEOUT_MS = 20_000

type Host = {
	port: number
	execs: () => readonly string[]
	close: () => Promise<void>
}

const generateKey = (dir: string, name: string): { privateKey: string; publicBlob: Buffer } => {
	const path = join(dir, name)
	execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", path, "-q"], {
		timeout: SPAWN_TIMEOUT_MS,
	})
	const publicLine = readFileSync(`${path}.pub`, "utf8").trim().split(" ")
	return {
		privateKey: readFileSync(path, "utf8"),
		publicBlob: Buffer.from(publicLine[1] ?? "", "base64"),
	}
}

const startHost = async (hostKey: Buffer): Promise<Host> => {
	const execs: string[] = []
	const clients: Array<{ end: () => void }> = []
	const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
		clients.push(client)
		client.on("error", () => undefined)
		client.on("authentication", (context) => {
			if (context.method === "publickey") context.accept()
			else context.reject(["publickey"])
		})
		client.on("ready", () => {
			client.on("session", (acceptSession) => {
				const session = acceptSession()
				session.on("exec", (acceptExec, _rejectExec, info) => {
					execs.push(info.command)
					const stream = acceptExec()
					const finish = () => {
						stream.write(`${info.command}\n`)
						stream.exit(0)
						stream.end()
					}
					if (info.command === HOLD_COMMAND) return
					if (info.command === BRIEF_COMMAND) {
						setTimeout(finish, BRIEF_HOLD_MS).unref()
						return
					}
					finish()
				})
			})
		})
	})
	const port = await new Promise<number>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			resolve(typeof address === "object" && address ? address.port : 0)
		})
	})
	return {
		port,
		execs: () => execs,
		close: () =>
			new Promise((resolve) => {
				for (const client of clients) client.end()
				server.close(() => resolve())
			}),
	}
}

const until = async (condition: () => boolean, withinMs = 5_000): Promise<void> => {
	const startedAt = Date.now()
	while (!condition()) {
		if (Date.now() - startedAt > withinMs) throw new Error("condition was never met")
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

let keyDir = ""
let clientKey = ""
let hostKey: Buffer = Buffer.alloc(0)
let fingerprint = ""

beforeAll(() => {
	keyDir = mkdtempSync(join(tmpdir(), "connection-queue-"))
	const client = generateKey(keyDir, "client")
	const host = generateKey(keyDir, "host")
	clientKey = client.privateKey
	hostKey = Buffer.from(host.privateKey)
	fingerprint = fingerprintFromKey(host.publicBlob)
})

afterAll(() => {
	rmSync(keyDir, { recursive: true, force: true })
})

const saturate = async (host: Host, command: string) => {
	const transport = createSshTransport()
	await transport.connect({
		hostname: "127.0.0.1",
		port: host.port,
		username: "tester",
		privateKey: clientKey,
		expectedFingerprint: fingerprint,
		timeoutMs: 5_000,
	})
	const holders = Array.from({ length: DEFAULT_EXEC_CONCURRENCY }, () =>
		transport.exec(command, HOLD_TIMEOUT_MS).then(
			() => undefined,
			() => undefined,
		),
	)
	await until(() => host.execs().length === DEFAULT_EXEC_CONCURRENCY)
	return { transport, holders }
}

describe("a command waiting behind the connection's channel limit", () => {
	it(
		"ends at the deadline it was given rather than waiting out the commands ahead of it",
		async () => {
			const host = await startHost(hostKey)
			const { transport, holders } = await saturate(host, HOLD_COMMAND)

			const startedAt = Date.now()
			const outcome = await Promise.race<Error | string>([
				transport.exec("echo queued", QUEUE_TIMEOUT_MS).then(
					() => "answered",
					(error: Error) => error,
				),
				new Promise<string>((resolve) => setTimeout(() => resolve("still queued"), WATCHDOG_MS)),
			])
			const waited = Date.now() - startedAt

			transport.destroy()
			await Promise.all(holders)
			await host.close()

			expect(outcome).toBeInstanceOf(ChannelQueueExpiredError)
			expect(waited).toBeLessThan(WATCHDOG_MS)
		},
		TEST_TIMEOUT_MS,
	)

	it(
		"costs the host nothing, because the command it gave up on was never sent",
		async () => {
			const host = await startHost(hostKey)
			const { transport, holders } = await saturate(host, HOLD_COMMAND)

			await transport.exec("echo queued", QUEUE_TIMEOUT_MS).catch(() => undefined)

			const seen = [...host.execs()]
			transport.destroy()
			await Promise.all(holders)
			await host.close()

			expect(seen).toEqual(Array.from({ length: DEFAULT_EXEC_CONCURRENCY }, () => HOLD_COMMAND))
		},
		TEST_TIMEOUT_MS,
	)

	it(
		"spends what it waited for a slot out of the deadline, rather than starting the clock again",
		async () => {
			const host = await startHost(hostKey)
			const { transport, holders } = await saturate(host, BRIEF_COMMAND)

			const startedAt = Date.now()
			const outcome = await transport.exec(HOLD_COMMAND, BEHIND_BRIEF_TIMEOUT_MS).then(
				() => "answered",
				(error: Error) => error,
			)
			const waited = Date.now() - startedAt

			transport.destroy()
			await Promise.all(holders)
			await host.close()

			expect(outcome).toBeInstanceOf(CommandTimedOutError)
			expect(waited).toBeGreaterThanOrEqual(BRIEF_HOLD_MS)
			expect(waited).toBeLessThan(BEHIND_BRIEF_CEILING_MS)
		},
		TEST_TIMEOUT_MS,
	)
})

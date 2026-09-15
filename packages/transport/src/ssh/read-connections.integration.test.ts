import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, connect as dial, type Server as NetServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
import { type Connection as ServerSideClient, Server as SshServer } from "ssh2"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { ReadDeadlineExceededError } from "../errors"
import {
	asReadCommand,
	type ConnectionIdentity,
	createReadConnections,
	READ_CONNECTION_CHANNEL_LIMIT,
} from "../read-connections"
import type { ReusableTransport } from "../types"
import { createSshTransport } from "./connection"

const ECHO_PORT = 4000

type Keys = { dir: string; clientKey: string; hostA: Buffer; hostB: Buffer; fingerprintA: string }

type Host = {
	port: number
	ready: () => number
	closed: () => number
	clients: ServerSideClient[]
	close: () => Promise<void>
}

type Proxy = {
	port: number
	retarget: (port: number) => void
	blackhole: () => void
	cutAll: () => void
	close: () => Promise<void>
}

const generateKey = (dir: string, name: string): { privateKey: string; publicBlob: Buffer } => {
	const path = join(dir, name)
	execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", path, "-q"])
	const publicLine = readFileSync(`${path}.pub`, "utf8").trim().split(" ")
	return {
		privateKey: readFileSync(path, "utf8"),
		publicBlob: Buffer.from(publicLine[1] ?? "", "base64"),
	}
}

const listen = (server: NetServer | SshServer): Promise<number> =>
	new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			resolve(typeof address === "object" && address ? address.port : 0)
		})
	})

const startHost = async (hostKey: Buffer): Promise<Host> => {
	let ready = 0
	let closed = 0
	const clients: ServerSideClient[] = []
	const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
		clients.push(client)
		client.on("error", () => undefined)
		client.on("close", () => {
			closed += 1
		})
		client.on("authentication", (context) => {
			if (context.method === "publickey") context.accept()
			else context.reject(["publickey"])
		})
		client.on("ready", () => {
			ready += 1
			client.on("session", (acceptSession) => {
				const session = acceptSession()
				session.on("exec", (acceptExec, _rejectExec, info) => {
					const stream = acceptExec()
					if (info.command === "hang") return
					stream.write(`${info.command}\n`)
					stream.exit(0)
					stream.end()
				})
			})
			client.on("tcpip", (acceptForward, rejectForward, info) => {
				if (info.destPort !== ECHO_PORT) {
					rejectForward()
					return
				}
				const stream = acceptForward()
				stream.on("data", (chunk: Buffer) => stream.write(chunk))
			})
		})
	})
	const port = await listen(server)
	return {
		port,
		ready: () => ready,
		closed: () => closed,
		clients,
		close: () =>
			new Promise((resolve) => {
				for (const client of clients) client.end()
				server.close(() => resolve())
			}),
	}
}

const startProxy = async (initialTarget: number): Promise<Proxy> => {
	let target = initialTarget
	const pairs = new Set<{ inbound: Socket; outbound: Socket; dead: boolean }>()
	const server = createServer((inbound) => {
		const pair = { inbound, outbound: dial(target, "127.0.0.1"), dead: false }
		pairs.add(pair)
		inbound.on("data", (chunk) => {
			if (!pair.dead) pair.outbound.write(chunk)
		})
		pair.outbound.on("data", (chunk) => {
			if (!pair.dead) inbound.write(chunk)
		})
		const end = () => {
			pairs.delete(pair)
			inbound.destroy()
			pair.outbound.destroy()
		}
		for (const socket of [inbound, pair.outbound]) {
			socket.on("close", end)
			socket.on("error", end)
		}
	})
	const port = await listen(server)
	return {
		port,
		retarget: (next) => {
			target = next
		},
		blackhole: () => {
			for (const pair of pairs) pair.dead = true
		},
		cutAll: () => {
			for (const pair of [...pairs]) {
				pair.inbound.destroy()
				pair.outbound.destroy()
			}
		},
		close: () =>
			new Promise((resolve) => {
				for (const pair of [...pairs]) {
					pair.inbound.destroy()
					pair.outbound.destroy()
				}
				server.close(() => resolve())
			}),
	}
}

const until = async (condition: () => boolean, withinMs = 3_000): Promise<void> => {
	const startedAt = Date.now()
	while (!condition()) {
		if (Date.now() - startedAt > withinMs) throw new Error("condition was never met")
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

const timed = async <T>(promise: Promise<T>): Promise<{ error: Error | undefined; ms: number }> => {
	const startedAt = Date.now()
	try {
		await promise
		return { error: undefined, ms: Date.now() - startedAt }
	} catch (error) {
		return { error: error instanceof Error ? error : undefined, ms: Date.now() - startedAt }
	}
}

let keys: Keys
const cleanups: Array<() => Promise<void> | void> = []

beforeAll(() => {
	const dir = mkdtempSync(join(tmpdir(), "read-connections-"))
	const client = generateKey(dir, "client")
	const hostA = generateKey(dir, "host-a")
	const hostB = generateKey(dir, "host-b")
	keys = {
		dir,
		clientKey: client.privateKey,
		hostA: Buffer.from(hostA.privateKey),
		hostB: Buffer.from(hostB.privateKey),
		fingerprintA: fingerprintFromKey(hostA.publicBlob),
	}
})

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

afterAll(() => {
	rmSync(keys.dir, { recursive: true, force: true })
})

const setUp = async (hardAgeMs = 120_000) => {
	const host = await startHost(keys.hostA)
	const proxy = await startProxy(host.port)
	const identity: ConnectionIdentity = {
		hostname: "127.0.0.1",
		port: proxy.port,
		username: "tester",
		sshKeyId: "key-1",
		hostKeyFingerprint: keys.fingerprintA,
	}
	const connections = createReadConnections({
		createTransport: createSshTransport,
		idleMs: 10_000,
		hardAgeMs,
		channelLimit: READ_CONNECTION_CHANNEL_LIMIT,
		now: () => Date.now(),
	})
	const open = (transport: ReusableTransport) =>
		transport.connect({
			hostname: "127.0.0.1",
			port: proxy.port,
			username: "tester",
			privateKey: keys.clientKey,
			expectedFingerprint: keys.fingerprintA,
			timeoutMs: 5_000,
		})
	const lease = (deadlineMs: number) =>
		connections.lease("org-1:host-1", identity, deadlineMs, open)
	cleanups.push(() => host.close())
	cleanups.push(() => proxy.close())
	cleanups.push(() => connections.evict("org-1:host-1"))
	return { host, proxy, connections, lease }
}

const echoOver = async (socket: Socket | NodeJS.ReadWriteStream, text: string): Promise<string> =>
	new Promise((resolve) => {
		socket.once("data", (chunk: Buffer) => resolve(chunk.toString()))
		socket.write(text)
	})

describe("reusing a real SSH connection", () => {
	it("I1: authenticates once for many commands and forwards from separate callers", async () => {
		const { host, lease } = await setUp()

		const answers = await Promise.all(
			Array.from({ length: 5 }, async (_, caller) => {
				const reader = await lease(5_000)
				try {
					const ran = await reader.exec(asReadCommand(`echo ${caller}`))
					const forwarded = await reader.forward(ECHO_PORT)
					const echoed = await echoOver(forwarded.socket, `ping ${caller}`)
					forwarded.close()
					return `${ran.stdout.trim()}|${echoed}`
				} finally {
					reader.release()
				}
			}),
		)

		expect(answers).toEqual([0, 1, 2, 3, 4].map((caller) => `echo ${caller}|ping ${caller}`))
		expect(host.ready()).toBe(1)
	}, 15_000)

	it("I2: fails every read on a black-holed connection by its own deadline, and reconnects after the first", async () => {
		const { host, proxy, lease } = await setUp()
		const warm = await lease(5_000)
		await warm.exec(asReadCommand("echo warm"))
		warm.release()
		proxy.blackhole()

		const consoleReader = await lease(900)
		const readoutReaders = await Promise.all([lease(500), lease(500), lease(500)])
		const healthReader = await lease(1_300)
		const outcomes = await Promise.all([
			timed(consoleReader.exec(asReadCommand("journalctl"))),
			...readoutReaders.map((reader) => timed(reader.forward(ECHO_PORT))),
			timed(healthReader.exec(asReadCommand("systemctl list-units"))),
		])
		const [consoleOutcome, first, second, third, healthOutcome] = outcomes

		for (const outcome of outcomes) expect(outcome.error).toBeInstanceOf(ReadDeadlineExceededError)
		for (const readout of [first, second, third]) {
			expect(readout?.ms).toBeGreaterThanOrEqual(490)
			expect(readout?.ms).toBeLessThan(850)
		}
		expect(consoleOutcome?.ms).toBeGreaterThanOrEqual(890)
		expect(healthOutcome?.ms).toBeGreaterThanOrEqual(1_290)

		const recovered = await lease(5_000)
		await expect(recovered.exec(asReadCommand("echo back"))).resolves.toMatchObject({
			stdout: "echo back\n",
		})
		expect(host.ready()).toBe(2)
		for (const reader of [consoleReader, ...readoutReaders, healthReader, recovered]) {
			reader.release()
		}
	}, 15_000)

	it("I3: reports a connection the server closed as disconnected", async () => {
		const host = await startHost(keys.hostA)
		cleanups.push(() => host.close())
		const transport = createSshTransport()
		cleanups.push(() => transport.destroy())
		await transport.connect({
			hostname: "127.0.0.1",
			port: host.port,
			username: "tester",
			privateKey: keys.clientKey,
			expectedFingerprint: keys.fingerprintA,
			timeoutMs: 5_000,
		})
		expect(transport.state()).toBe("ready")

		for (const client of host.clients) client.end()

		await until(() => transport.state() === "disconnected")
	}, 15_000)

	it("I4: installs nothing when the host comes back with a different key", async () => {
		const { host, proxy, connections, lease } = await setUp()
		const first = await lease(5_000)
		first.release()

		const impostor = await startHost(keys.hostB)
		cleanups.push(() => impostor.close())
		proxy.retarget(impostor.port)
		proxy.cutAll()
		await until(() => host.closed() === 1)

		await expect(lease(5_000)).rejects.toThrow()
		await expect(lease(5_000)).rejects.toThrow()
		expect(impostor.ready()).toBe(0)
		expect(connections.activeLeases()).toBe(0)
	}, 15_000)

	it("I5: drops the socket at the hard age even while a lease is still out", async () => {
		const { host, connections, lease } = await setUp(1_500)
		const startedAt = Date.now()
		const outstanding = await lease(1_000)

		await until(() => host.closed() === 1, 5_000)

		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400)
		expect(connections.activeLeases()).toBe(1)
		outstanding.release()
	}, 15_000)
})

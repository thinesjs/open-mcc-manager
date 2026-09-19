import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	ChannelQueueExpiredError,
	ReadConnectionLostError,
	ReadDeadlineExceededError,
} from "./errors"
import { createFakeTransport, type FakeFailures, type FakeScript } from "./fake"
import {
	asReadCommand,
	type ConnectionIdentity,
	createReadConnections,
	type HostReader,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
	type ReadCommand,
} from "./read-connections"
import { ChannelLimitReachedError } from "./ssh/exec"
import { type HostTransport, LiveChannelUnavailableError, type ReusableTransport } from "./types"

const HOST = "org-1:host-1"

const IDENTITY: ConnectionIdentity = {
	hostname: "10.0.0.1",
	port: 22,
	username: "mcc",
	sshKeyId: "key-1",
	hostKeyFingerprint: "SHA256:first",
}

const connect = async (transport: ReusableTransport): Promise<void> => {
	await transport.connect({
		hostname: "10.0.0.1",
		port: 22,
		username: "mcc",
		privateKey: "PRIVATE KEY",
		expectedFingerprint: "SHA256:first",
		timeoutMs: 10_000,
	})
}

const deferred = () => {
	let open: () => void = () => undefined
	const opened = new Promise<void>((resolve) => {
		open = resolve
	})
	return { opened, open }
}

const harness = (
	script: FakeScript = {},
	failures: FakeFailures = {},
	forwarding = true,
	wrap: (transport: ReusableTransport) => ReusableTransport = (transport) => transport,
) => {
	const made: Array<ReturnType<typeof createFakeTransport>> = []
	const connections = createReadConnections({
		createTransport: () => {
			const transport = createFakeTransport(script, failures, forwarding)
			made.push(transport)
			return wrap(transport)
		},
		idleMs: READ_CONNECTION_IDLE_MS,
		hardAgeMs: READ_CONNECTION_HARD_AGE_MS,
		channelLimit: READ_CONNECTION_CHANNEL_LIMIT,
		now: () => Date.now(),
	})
	const lease = (deadlineMs = 10_000, identity = IDENTITY, key = HOST) =>
		connections.lease(key, identity, deadlineMs, connect)
	return { connections, made, lease }
}

const settledState = async <T>(promise: Promise<T>): Promise<"pending" | "settled"> => {
	let state: "pending" | "settled" = "pending"
	promise.then(
		() => {
			state = "settled"
		},
		() => {
			state = "settled"
		},
	)
	await vi.advanceTimersByTimeAsync(0)
	return state
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("sharing one connection per host", () => {
	it("T1: opens one connection for ten reads that arrive together", async () => {
		const { made, lease } = harness()

		const readers = await Promise.all(Array.from({ length: 10 }, () => lease()))

		expect(made).toHaveLength(1)
		for (const reader of readers) reader.release()
	})

	it("T2: fails every waiter when the open fails, and opens again on the next read", async () => {
		const { connections, made, lease } = harness()
		const refused = new Error("the host refused this key")

		const outcomes = await Promise.allSettled(
			Array.from({ length: 10 }, () =>
				connections.lease(HOST, IDENTITY, 10_000, async () => {
					throw refused
				}),
			),
		)

		expect(outcomes.every((each) => each.status === "rejected" && each.reason === refused)).toBe(
			true,
		)
		expect(made).toHaveLength(1)
		const reader = await lease()
		expect(made).toHaveLength(2)
		reader.release()
	})

	it("T2: opens again on the next read after an open that fails before it returns a promise", async () => {
		const { connections, made, lease } = harness()
		const refused = new Error("the key could not be read")
		const refuseAtOnce = (): Promise<void> => {
			throw refused
		}

		await expect(connections.lease(HOST, IDENTITY, 10_000, refuseAtOnce)).rejects.toBe(refused)
		expect(made).toHaveLength(1)

		const reader = await lease()
		expect(made).toHaveLength(2)
		reader.release()
	})

	it("T3: destroys the old connection and opens one new one when the fingerprint changes", async () => {
		const { made, lease } = harness()
		const first = await lease()
		first.release()

		const second = await lease(10_000, { ...IDENTITY, hostKeyFingerprint: "SHA256:second" })

		expect(made).toHaveLength(2)
		expect(made[0]?.destroyCount()).toBe(1)
		second.release()
	})

	it("T4: destroys the connection on evict even with a lease still out, and opens under a new generation", async () => {
		const { connections, made, lease } = harness()
		const outstanding = await lease()

		connections.evict(HOST)

		expect(made[0]?.destroyCount()).toBe(1)
		await expect(outstanding.exec(asReadCommand("uname -m"))).rejects.toBeInstanceOf(
			ReadConnectionLostError,
		)
		const next = await lease()
		expect(made).toHaveLength(2)
		outstanding.release()
		next.release()
	})

	it("T5: keeps two organizations that enrolled the same address on separate connections", async () => {
		const { connections, made, lease } = harness()
		const a = await lease(10_000, IDENTITY, "org-a:host-1")
		const b = await lease(10_000, IDENTITY, "org-b:host-1")

		connections.evict("org-a:host-1")

		expect(made).toHaveLength(2)
		expect(made[0]?.destroyCount()).toBe(1)
		expect(made[1]?.destroyCount()).toBe(0)
		await expect(b.exec(asReadCommand("uname -m"))).resolves.toMatchObject({ exitCode: 0 })
		a.release()
		b.release()
	})
})

describe("how long a connection lives", () => {
	it("T6: reuses a connection just inside ten idle seconds and ends it gracefully at ten", async () => {
		const { made, lease } = harness()
		const first = await lease()
		first.release()

		await vi.advanceTimersByTimeAsync(9_900)
		const second = await lease()
		expect(made).toHaveLength(1)
		second.release()

		await vi.advanceTimersByTimeAsync(9_999)
		expect(made[0]?.closeCount()).toBe(0)
		await vi.advanceTimersByTimeAsync(1)
		expect(made[0]?.closeCount()).toBe(1)
		expect(made[0]?.destroyCount()).toBe(0)
	})

	it("T7: destroys a connection at its hard age even with a lease still out", async () => {
		const { made, lease } = harness()
		const outstanding = await lease()

		await vi.advanceTimersByTimeAsync(READ_CONNECTION_HARD_AGE_MS - 1)
		expect(made[0]?.destroyCount()).toBe(0)
		await vi.advanceTimersByTimeAsync(1)

		expect(made[0]?.destroyCount()).toBe(1)
		await expect(outstanding.exec(asReadCommand("uname -m"))).rejects.toBeInstanceOf(
			ReadConnectionLostError,
		)
		outstanding.release()
	})

	it("T8: opens a new connection after the old one dropped", async () => {
		const { made, lease } = harness()
		const first = await lease()
		first.release()

		made[0]?.drop()
		const second = await lease()

		expect(made).toHaveLength(2)
		second.release()
	})

	it("T14: opens a replacement when a read would outlive the connection, and lets the old one finish its lease", async () => {
		const { made, lease } = harness()
		const old = await lease(115_000)

		await vi.advanceTimersByTimeAsync(111_000)
		const late = await lease(10_000)
		expect(made).toHaveLength(2)

		await vi.advanceTimersByTimeAsync(1_000)
		const later = await lease(10_000)
		expect(made).toHaveLength(2)

		await expect(old.exec(asReadCommand("uname -m"))).resolves.toMatchObject({ exitCode: 0 })
		expect(made[0]?.commands).toEqual(["uname -m"])

		await vi.advanceTimersByTimeAsync(8_000)
		expect(made[0]?.destroyCount()).toBe(1)
		expect(made[1]?.destroyCount()).toBe(0)
		old.release()
		late.release()
		later.release()
	})

	it("T14: does not open a side connection per read in a connection's last seconds", async () => {
		const { made, lease } = harness()
		const holder = await lease(119_000)

		await vi.advanceTimersByTimeAsync(111_000)
		const readers: HostReader[] = []
		for (let second = 0; second < 8; second += 1) {
			readers.push(await lease(10_000))
			await vi.advanceTimersByTimeAsync(1_000)
		}

		expect(made).toHaveLength(2)
		holder.release()
		for (const reader of readers) reader.release()
	})
})

describe("deciding what a failure says about the connection", () => {
	it("T9: retires the connection when a read's deadline passes with its command on the host", async () => {
		const { made, lease } = harness({}, { stall: ["sleep 60"] })
		const short = await lease(10_000)
		const long = await lease(30_000)
		const shortRead = short.exec(asReadCommand("sleep 60"))
		const shortOutcome = expect(shortRead).rejects.toBeInstanceOf(ReadDeadlineExceededError)
		const longRead = long.exec(asReadCommand("sleep 60"))
		const longOutcome = expect(longRead).rejects.toBeInstanceOf(ReadDeadlineExceededError)

		await vi.advanceTimersByTimeAsync(10_000)
		await shortOutcome
		expect(await settledState(longRead)).toBe("pending")

		const next = await lease(10_000)
		expect(made).toHaveLength(2)
		await expect(long.exec(asReadCommand("uname -m"))).resolves.toMatchObject({ exitCode: 0 })
		expect(made[0]?.destroyCount()).toBe(0)

		await vi.advanceTimersByTimeAsync(20_000)
		await longOutcome
		short.release()
		long.release()
		expect(made[0]?.destroyCount()).toBe(1)
		next.release()
	})

	it("T10: keeps the connection after a refused channel, a failing command or a refused forward", async () => {
		const { made, lease } = harness(
			{ false: { stdout: "", stderr: "", exitCode: 1 } },
			{ exec: { "too many": new ChannelLimitReachedError("MaxSessions") } },
			false,
		)
		const reader = await lease()

		await expect(reader.exec(asReadCommand("too many"))).rejects.toBeInstanceOf(
			ChannelLimitReachedError,
		)
		await expect(reader.exec(asReadCommand("false"))).resolves.toMatchObject({ exitCode: 1 })
		await expect(reader.forward(33333)).rejects.toBeInstanceOf(LiveChannelUnavailableError)
		reader.release()

		const next = await lease()
		expect(made).toHaveLength(1)
		next.release()
	})

	it("T11: does not join an open for a different identity, and destroys that stale open when it lands", async () => {
		const { connections, made } = harness()
		const gate = deferred()
		const stale = connections.lease(HOST, IDENTITY, 10_000, async (transport) => {
			await gate.opened
			await connect(transport)
		})
		const staleOutcome = expect(stale).rejects.toBeInstanceOf(ReadConnectionLostError)

		const current = await connections.lease(
			HOST,
			{ ...IDENTITY, hostKeyFingerprint: "SHA256:second" },
			10_000,
			connect,
		)
		expect(made).toHaveLength(2)

		gate.open()
		await staleOutcome
		expect(made[0]?.destroyCount()).toBe(1)
		expect(made[1]?.destroyCount()).toBe(0)
		current.release()
	})

	it("T13: destroys an open that was pending when the host was evicted, fails its waiters, and connects afresh", async () => {
		const { connections, made, lease } = harness()
		const gate = deferred()
		const gated = async (transport: ReusableTransport) => {
			await gate.opened
			await connect(transport)
		}
		const first = connections.lease(HOST, IDENTITY, 10_000, gated)
		const joined = connections.lease(HOST, IDENTITY, 10_000, gated)
		const firstOutcome = expect(first).rejects.toBeInstanceOf(ReadConnectionLostError)
		const joinedOutcome = expect(joined).rejects.toBeInstanceOf(ReadConnectionLostError)
		await vi.advanceTimersByTimeAsync(0)
		expect(made).toHaveLength(1)

		connections.evict(HOST)
		gate.open()

		await firstOutcome
		await joinedOutcome
		expect(made[0]?.destroyCount()).toBe(1)
		const next = await lease()
		expect(made).toHaveLength(2)
		next.release()
	})

	it("T13: does not let a read that starts after the evict join the open still pending from before it", async () => {
		const { connections, made } = harness()
		const gate = deferred()
		const gated = async (transport: ReusableTransport) => {
			await gate.opened
			await connect(transport)
		}
		const before = connections.lease(HOST, IDENTITY, 10_000, gated)
		const beforeOutcome = expect(before).rejects.toBeInstanceOf(ReadConnectionLostError)
		await vi.advanceTimersByTimeAsync(0)

		connections.evict(HOST)
		const afterEvict = connections.lease(HOST, IDENTITY, 10_000, connect)
		await vi.advanceTimersByTimeAsync(0)
		expect(made).toHaveLength(2)

		gate.open()
		await beforeOutcome
		const reader = await afterEvict
		await expect(reader.exec(asReadCommand("uname -m"))).resolves.toMatchObject({ exitCode: 0 })
		expect(made[1]?.commands).toEqual(["uname -m"])
		expect(made[0]?.commands).toEqual([])
		reader.release()
	})
})

describe("sharing the connection's channels", () => {
	it("T12: expires a read waiting in the local queue without retiring the connection, and leaks no slot", async () => {
		const { made, lease } = harness({}, { stall: ["sleep 60"] })
		const holders = await Promise.all(Array.from({ length: 6 }, () => lease(60_000)))
		const held = holders.map((holder) => holder.exec(asReadCommand("sleep 60")).catch(() => "gone"))
		await vi.advanceTimersByTimeAsync(0)

		const queued = await lease(1_000)
		const waiting = queued.exec(asReadCommand("uname -m"))
		const expired = expect(waiting).rejects.toBeInstanceOf(ChannelQueueExpiredError)
		await vi.advanceTimersByTimeAsync(1_000)
		await expired
		queued.release()

		const afterExpiry = await lease(10_000)
		expect(made).toHaveLength(1)

		for (const holder of holders) holder.release()
		await Promise.all(held)
		const outcomes = Array.from({ length: 6 }, () => afterExpiry.exec(asReadCommand("uname -m")))
		expect(await settledState(Promise.all(outcomes))).toBe("settled")
		await expect(Promise.all(outcomes)).resolves.toHaveLength(6)
		afterExpiry.release()
	})

	it("T16: counts open forwards against the limit, and lets a waiting command in when one closes", async () => {
		const { lease } = harness()
		const holder = await lease(60_000)
		const streams = await Promise.all(Array.from({ length: 6 }, () => holder.forward(33333)))

		const reader = await lease(3_000)
		const waiting = reader.exec(asReadCommand("uname -m"))
		await vi.advanceTimersByTimeAsync(2_000)
		expect(await settledState(waiting)).toBe("pending")

		streams[0]?.close()
		await expect(waiting).resolves.toMatchObject({ exitCode: 0 })
		reader.release()

		const extra = await holder.forward(33333)
		const late = await lease(3_000)
		const starved = late.exec(asReadCommand("uname -m"))
		const outcome = expect(starved).rejects.toBeInstanceOf(ChannelQueueExpiredError)
		await vi.advanceTimersByTimeAsync(3_000)
		await outcome
		late.release()
		extra.close()
		holder.release()
	})
})

type Assignable<From, To> = [From] extends [To] ? true : false

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

describe("T17: what a reader can be handed, checked by the compiler", () => {
	const plainTextIsNotAReadCommand: Assignable<string, Parameters<HostReader["exec"]>[0]> = false
	const aLookalikeIsNotAReadCommand: Assignable<{ command: string }, ReadCommand> = false
	const execTakesTheCommandAlone: Same<Parameters<HostReader["exec"]>["length"], 1> = true
	const aReaderIsNotATransport: Assignable<HostReader, HostTransport> = false

	it("refuses plain text, a lookalike, stdin, and use as a full transport", () => {
		expect([
			plainTextIsNotAReadCommand,
			aLookalikeIsNotAReadCommand,
			execTakesTheCommandAlone,
			aReaderIsNotATransport,
		]).toEqual([false, false, true, false])
	})

	it("refuses a deadline the connection could never outlive", async () => {
		const { connections } = harness()

		await expect(
			connections.lease(HOST, IDENTITY, READ_CONNECTION_HARD_AGE_MS, connect),
		).rejects.toBeInstanceOf(RangeError)
	})
})

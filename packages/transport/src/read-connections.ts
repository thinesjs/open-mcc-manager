import {
	ChannelQueueExpiredError,
	ReadConnectionLostError,
	ReadDeadlineExceededError,
} from "./errors"
import { type ChannelLimiter, createChannelLimiter, DEFAULT_EXEC_CONCURRENCY } from "./ssh/limiter"
import type { ExecResult, ForwardedStream, ReusableTransport } from "./types"

const READ_COMMAND: unique symbol = Symbol("ReadCommand")

export const asReadCommand = (command: string) => ({ [READ_COMMAND]: command }) as const

export type ReadCommand = ReturnType<typeof asReadCommand>

export const readCommandText = (command: ReadCommand): string => command[READ_COMMAND]

export const READ_CONNECTION_IDLE_MS = 10_000

export const READ_CONNECTION_HARD_AGE_MS = 120_000

export const READ_CONNECTION_CHANNEL_LIMIT = DEFAULT_EXEC_CONCURRENCY

export type ConnectionIdentity = {
	hostname: string
	port: number
	username: string
	sshKeyId: string
	hostKeyFingerprint: string
}

export const sameConnectionIdentity = (a: ConnectionIdentity, b: ConnectionIdentity): boolean =>
	a.hostname === b.hostname &&
	a.port === b.port &&
	a.username === b.username &&
	a.sshKeyId === b.sshKeyId &&
	a.hostKeyFingerprint === b.hostKeyFingerprint

export type HostReader = {
	exec: (command: ReadCommand) => Promise<ExecResult>
	forward: (port: number) => Promise<ForwardedStream>
	release: () => void
}

export type OpenConnection = (transport: ReusableTransport) => Promise<void>

export type ReadConnectionsOptions = {
	createTransport: () => ReusableTransport
	idleMs: number
	hardAgeMs: number
	channelLimit: number
	now: () => number
}

type Timer = ReturnType<typeof setTimeout>

type Entry = {
	generation: number
	installed: Connection | undefined
	pending: Pending | undefined
	readonly connections: Set<Connection>
}

type Pending = {
	readonly id: number
	readonly identity: ConnectionIdentity
	readonly generation: number
	readonly done: Promise<Connection>
}

type Connection = {
	readonly key: string
	readonly entry: Entry
	readonly transport: ReusableTransport
	readonly identity: ConnectionIdentity
	readonly readyAt: number
	readonly limiter: ChannelLimiter
	readonly leases: Set<Lease>
	readonly ops: Set<Op>
	retired: boolean
	closed: boolean
	idleTimer: Timer | undefined
	hardTimer: Timer | undefined
}

type Lease = {
	readonly connection: Connection
	readonly ops: Set<Op>
	expired: boolean
	released: boolean
	timer: Timer | undefined
}

type Op = {
	readonly lease: Lease
	readonly controller: AbortController
	state: "queued" | "requested" | "open"
	holdsSlot: boolean
	settled: boolean
	stream: ForwardedStream | undefined
	fail: (error: Error) => void
	atDeadline: () => void
}

const unref = (timer: Timer): Timer => {
	timer.unref?.()
	return timer
}

const connectionLost = (): Error =>
	new ReadConnectionLostError("The connection to the host was closed")

const queueExpired = (): Error =>
	new ChannelQueueExpiredError("The read waited too long for a free channel")

const deadlinePassed = (): Error =>
	new ReadDeadlineExceededError("The host did not answer before the read's deadline")

export const createReadConnections = (options: ReadConnectionsOptions) => {
	const entries = new Map<string, Entry>()
	let generations = 0
	let opens = 0
	let leaseCount = 0

	const entryFor = (key: string): Entry => {
		const found = entries.get(key)
		if (found) return found
		generations += 1
		const created: Entry = {
			generation: generations,
			installed: undefined,
			pending: undefined,
			connections: new Set(),
		}
		entries.set(key, created)
		return created
	}

	const prune = (key: string, entry: Entry): void => {
		if (entry.connections.size > 0 || entry.pending !== undefined) return
		if (entries.get(key) === entry) entries.delete(key)
	}

	const finishOp = (op: Op): void => {
		const { connection } = op.lease
		op.lease.ops.delete(op)
		connection.ops.delete(op)
		if (!op.holdsSlot) return
		op.holdsSlot = false
		connection.limiter.release()
	}

	const abandon = (op: Op, error: Error): void => {
		const stream = op.stream
		if (!op.settled) {
			op.settled = true
			op.fail(error)
		}
		op.controller.abort(error)
		finishOp(op)
		if (!stream) return
		if (stream.socket.listenerCount("error") > 0) stream.socket.destroy(error)
		else stream.socket.destroy()
	}

	const shutDown = (connection: Connection, how: "end" | "destroy"): void => {
		if (connection.closed) return
		connection.closed = true
		clearTimeout(connection.idleTimer)
		clearTimeout(connection.hardTimer)
		const { entry } = connection
		if (entry.installed === connection) entry.installed = undefined
		entry.connections.delete(connection)
		const lost = connectionLost()
		for (const op of [...connection.ops]) abandon(op, lost)
		if (how === "destroy") connection.transport.destroy()
		else void connection.transport.close().catch(() => undefined)
		prune(connection.key, entry)
	}

	const retire = (connection: Connection): void => {
		connection.retired = true
		if (connection.entry.installed === connection) connection.entry.installed = undefined
	}

	const afterLastLease = (connection: Connection): void => {
		if (connection.closed || connection.leases.size > 0) return
		if (connection.retired) {
			shutDown(connection, "destroy")
			return
		}
		if (connection.entry.installed !== connection) {
			shutDown(connection, "end")
			return
		}
		clearTimeout(connection.idleTimer)
		connection.idleTimer = unref(setTimeout(() => shutDown(connection, "end"), options.idleMs))
	}

	const expire = (lease: Lease): void => {
		lease.expired = true
		for (const op of [...lease.ops]) {
			if (op.state === "queued") {
				abandon(op, queueExpired())
				continue
			}
			retire(lease.connection)
			op.atDeadline()
		}
	}

	const install = (
		key: string,
		entry: Entry,
		transport: ReusableTransport,
		identity: ConnectionIdentity,
	): Connection => {
		const connection: Connection = {
			key,
			entry,
			transport,
			identity,
			readyAt: options.now(),
			limiter: createChannelLimiter(options.channelLimit),
			leases: new Set(),
			ops: new Set(),
			retired: false,
			closed: false,
			idleTimer: undefined,
			hardTimer: undefined,
		}
		connection.hardTimer = unref(
			setTimeout(() => shutDown(connection, "destroy"), options.hardAgeMs),
		)
		const previous = entry.installed
		entry.installed = connection
		entry.connections.add(connection)
		if (previous && !sameConnectionIdentity(previous.identity, identity)) {
			shutDown(previous, "destroy")
		} else if (previous) {
			afterLastLease(previous)
		}
		return connection
	}

	const startOpen = (
		key: string,
		entry: Entry,
		identity: ConnectionIdentity,
		open: OpenConnection,
	): Promise<Connection> => {
		opens += 1
		const id = opens
		const generation = entry.generation
		const transport = options.createTransport()
		const giveUp = (): void => {
			transport.destroy()
			if (entry.pending?.id !== id) return
			entry.pending = undefined
			prune(key, entry)
		}
		const done = (async () => {
			try {
				await Promise.resolve(transport).then(open)
			} catch (error) {
				giveUp()
				throw error
			}
			const current = entry.pending?.id === id && entry.generation === generation
			if (!current || transport.state() !== "ready") {
				giveUp()
				throw new ReadConnectionLostError("The host changed while its connection was opening")
			}
			entry.pending = undefined
			return install(key, entry, transport, identity)
		})()
		entry.pending = { id, identity, generation, done }
		return done
	}

	const begin = (lease: Lease, fail: (error: Error) => void): Op | undefined => {
		const { connection } = lease
		if (lease.released || connection.closed) {
			fail(connectionLost())
			return undefined
		}
		if (lease.expired) {
			fail(queueExpired())
			return undefined
		}
		const op: Op = {
			lease,
			controller: new AbortController(),
			state: "queued",
			holdsSlot: false,
			settled: false,
			stream: undefined,
			fail,
			atDeadline: () => abandon(op, deadlinePassed()),
		}
		lease.ops.add(op)
		connection.ops.add(op)
		return op
	}

	const whenAdmitted = (op: Op, run: () => void): void => {
		const { limiter } = op.lease.connection
		limiter.acquire(op.controller.signal).then(
			() => {
				if (op.settled) {
					limiter.release()
					return
				}
				op.holdsSlot = true
				op.state = "requested"
				run()
			},
			() => undefined,
		)
	}

	const outcomeOf = (connection: Connection, error: Error): Error =>
		connection.closed || connection.transport.state() !== "ready" ? connectionLost() : error

	const readerFor = (lease: Lease): HostReader => {
		const { connection } = lease
		return {
			exec: (command) =>
				new Promise<ExecResult>((resolve, reject) => {
					const op = begin(lease, reject)
					if (!op) return
					whenAdmitted(op, () => {
						connection.transport.execUntil(readCommandText(command), op.controller.signal).then(
							(result) => {
								if (op.settled) return
								op.settled = true
								finishOp(op)
								resolve(result)
							},
							(error: Error) => {
								if (op.settled) return
								op.settled = true
								finishOp(op)
								reject(outcomeOf(connection, error))
							},
						)
					})
				}),

			forward: (port) =>
				new Promise<ForwardedStream>((resolve, reject) => {
					const op = begin(lease, reject)
					if (!op) return
					whenAdmitted(op, () => {
						connection.transport.forwardUntil(port, op.controller.signal).then(
							(stream) => {
								if (op.settled) {
									stream.close()
									return
								}
								op.settled = true
								op.state = "open"
								op.stream = stream
								stream.socket.once("close", () => finishOp(op))
								resolve({
									socket: stream.socket,
									close: () => {
										finishOp(op)
										stream.close()
									},
								})
							},
							(error: Error) => {
								if (op.settled) return
								op.settled = true
								finishOp(op)
								reject(outcomeOf(connection, error))
							},
						)
					})
				}),

			release: () => {
				if (lease.released) return
				lease.released = true
				leaseCount -= 1
				clearTimeout(lease.timer)
				const lost = connectionLost()
				for (const op of [...lease.ops]) abandon(op, lost)
				connection.leases.delete(lease)
				afterLastLease(connection)
			},
		}
	}

	const checkout = (connection: Connection, deadlineMs: number): HostReader => {
		clearTimeout(connection.idleTimer)
		connection.idleTimer = undefined
		const lease: Lease = {
			connection,
			ops: new Set(),
			expired: false,
			released: false,
			timer: undefined,
		}
		lease.timer = unref(setTimeout(() => expire(lease), deadlineMs))
		connection.leases.add(lease)
		leaseCount += 1
		return readerFor(lease)
	}

	const usable = (connection: Connection, identity: ConnectionIdentity): boolean =>
		!connection.closed &&
		!connection.retired &&
		connection.transport.state() === "ready" &&
		sameConnectionIdentity(connection.identity, identity)

	return {
		lease: async (
			key: string,
			identity: ConnectionIdentity,
			deadlineMs: number,
			open: OpenConnection,
		): Promise<HostReader> => {
			if (!(deadlineMs > 0 && deadlineMs < options.hardAgeMs)) {
				throw new RangeError("A read's deadline must be above zero and below the hard age")
			}
			for (;;) {
				const entry = entryFor(key)
				const installed = entry.installed
				if (installed && !usable(installed, identity)) {
					shutDown(installed, "destroy")
				} else if (
					installed &&
					installed.readyAt + options.hardAgeMs >= options.now() + deadlineMs
				) {
					return checkout(installed, deadlineMs)
				}
				const pending = entry.pending
				const joinable =
					pending !== undefined &&
					pending.generation === entry.generation &&
					sameConnectionIdentity(pending.identity, identity)
				const connection = await (joinable ? pending.done : startOpen(key, entry, identity, open))
				if (usable(connection, identity)) return checkout(connection, deadlineMs)
			}
		},

		evict: (key: string): void => {
			const entry = entries.get(key)
			if (!entry) return
			generations += 1
			entry.generation = generations
			for (const connection of [...entry.connections]) shutDown(connection, "destroy")
			prune(key, entry)
		},

		activeLeases: (): number => leaseCount,
	}
}

export type ReadConnections = ReturnType<typeof createReadConnections>

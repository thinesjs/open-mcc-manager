import { PassThrough } from "node:stream"
import { ReadConnectionLostError } from "./errors"
import {
	createReadConnections,
	type HostReader,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
} from "./read-connections"
import type { RootSession, RootSessionOptions } from "./ssh/root-session"
import {
	type ConnectionState,
	type ExecResult,
	type ForwardedStream,
	LiveChannelUnavailableError,
	type ReusableTransport,
} from "./types"

export type FakeRootSessionScript = {
	connect?: Error
	run?: Error
	result?: ExecResult
}

export type FakeRootSession = RootSession & {
	attempts: RootSessionOptions[]
	commands: string[]
	closeCount: () => number
}

export const createFakeRootSession = (script: FakeRootSessionScript = {}): FakeRootSession => {
	const attempts: RootSessionOptions[] = []
	const commands: string[] = []
	let closes = 0

	return {
		attempts,
		commands,
		closeCount: () => closes,
		connect: async (options) => {
			attempts.push(options)
			if (script.connect) throw script.connect
		},
		run: async (command) => {
			commands.push(command)
			if (script.run) throw script.run
			return script.result ?? { stdout: "", stderr: "", exitCode: 0 }
		},
		close: () => {
			closes += 1
		},
	}
}

export type FakeScript = Record<string, ExecResult>

export const FAKE_HOST_DEFAULTS: FakeScript = {
	"uname -m": { stdout: "x86_64", stderr: "", exitCode: 0 },
}

export type FakeFailures = {
	connect?: Error
	exec?: Record<string, Error>
	stall?: readonly string[]
	stallPorts?: readonly number[]
	refusePorts?: readonly number[]
}

export const createFakeTransport = (
	script: FakeScript = {},
	failures: FakeFailures = {},
	forwarding = true,
	listening: readonly number[] = [],
): ReusableTransport & {
	commands: string[]
	forwarded: number[]
	stdins: string[]
	timeouts: number[]
	destroyCount: () => number
	closeCount: () => number
	drop: () => void
} => {
	let state: ConnectionState = "disconnected"
	let destroys = 0
	let closes = 0
	const commands: string[] = []
	const forwarded: number[] = []
	const stdins: string[] = []
	const timeouts: number[] = []
	const stalled = new Set<(error: Error) => void>()
	const sockets = new Set<PassThrough>()

	const disconnect = (): void => {
		state = "disconnected"
		const lost = new ReadConnectionLostError("The fake connection closed")
		for (const fail of [...stalled]) fail(lost)
		for (const socket of [...sockets]) socket.destroy()
	}

	const stallUntilAbandoned = <T>(signal: AbortSignal): Promise<T> =>
		new Promise<T>((_resolve, reject) => {
			const fail = (error: Error): void => {
				stalled.delete(fail)
				signal.removeEventListener("abort", abandon)
				reject(error)
			}
			const abandon = (): void =>
				fail(signal.reason instanceof Error ? signal.reason : new Error("abandoned"))
			stalled.add(fail)
			signal.addEventListener("abort", abandon, { once: true })
		})

	const openStream = (port: number): ForwardedStream => {
		forwarded.push(port)
		const socket = new PassThrough()
		sockets.add(socket)
		socket.on("close", () => sockets.delete(socket))
		return { socket, close: () => socket.destroy() }
	}

	const scripted = (command: string): ExecResult =>
		script[command] ?? FAKE_HOST_DEFAULTS[command] ?? { stdout: "", stderr: "", exitCode: 0 }

	return {
		commands,
		forwarded,
		stdins,
		timeouts,
		destroyCount: () => destroys,
		closeCount: () => closes,
		drop: disconnect,
		state: () => state,
		connect: async () => {
			const failure = failures.connect
			if (failure) {
				state = "failed"
				throw failure
			}
			state = "ready"
		},
		canForward: async (port: number) => forwarding && listening.includes(port),

		forward: async (port: number) => {
			if (!forwarding) throw new LiveChannelUnavailableError(`Forwarding is refused`)
			return openStream(port)
		},

		exec: async (command: string, timeoutMs?: number, stdin?: string) => {
			if (state !== "ready") throw new Error("Transport is not connected")
			commands.push(command)
			if (timeoutMs !== undefined) timeouts.push(timeoutMs)
			if (stdin !== undefined) stdins.push(stdin)
			const failure = failures.exec?.[command]
			if (failure) throw failure
			return scripted(command)
		},

		execUntil: async (command: string, signal: AbortSignal) => {
			if (state !== "ready") throw new ReadConnectionLostError("The fake connection is not open")
			commands.push(command)
			const failure = failures.exec?.[command]
			if (failure) throw failure
			if (failures.stall?.includes(command)) return await stallUntilAbandoned<ExecResult>(signal)
			return scripted(command)
		},

		forwardUntil: async (port: number, signal: AbortSignal) => {
			if (state !== "ready") throw new ReadConnectionLostError("The fake connection is not open")
			if (!forwarding || failures.refusePorts?.includes(port)) {
				throw new LiveChannelUnavailableError("Forwarding is refused")
			}
			if (failures.stallPorts?.includes(port)) {
				return await stallUntilAbandoned<ForwardedStream>(signal)
			}
			return openStream(port)
		},

		close: async () => {
			closes += 1
			disconnect()
		},

		destroy: () => {
			destroys += 1
			disconnect()
		},
	}
}

export const readerOver = (
	transport: ReusableTransport,
	deadlineMs = 60_000,
): Promise<HostReader> =>
	createReadConnections({
		createTransport: () => transport,
		idleMs: READ_CONNECTION_IDLE_MS,
		hardAgeMs: READ_CONNECTION_HARD_AGE_MS,
		channelLimit: READ_CONNECTION_CHANNEL_LIMIT,
		now: () => Date.now(),
	}).lease(
		"fake",
		{ hostname: "fake", port: 22, username: "fake", sshKeyId: "fake", hostKeyFingerprint: "fake" },
		deadlineMs,
		async (opened) => {
			if (opened.state() === "ready") return
			await opened.connect({
				hostname: "fake",
				port: 22,
				username: "fake",
				privateKey: "fake",
				expectedFingerprint: "fake",
				timeoutMs: 1_000,
			})
		},
	)

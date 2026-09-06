import { PassThrough } from "node:stream"
import {
	type ConnectionState,
	type ExecResult,
	type HostTransport,
	LiveChannelUnavailableError,
} from "./types"

export type FakeScript = Record<string, ExecResult>

export const FAKE_HOST_DEFAULTS: FakeScript = {
	"uname -m": { stdout: "x86_64", stderr: "", exitCode: 0 },
}

export type FakeFailures = {
	connect?: Error
	exec?: Record<string, Error>
}

export const createFakeTransport = (
	script: FakeScript = {},
	failures: FakeFailures = {},
	forwarding = true,
	listening: readonly number[] = [],
): HostTransport & {
	commands: string[]
	forwarded: number[]
	stdins: string[]
	timeouts: number[]
} => {
	let state: ConnectionState = "disconnected"
	const commands: string[] = []
	const forwarded: number[] = []
	const stdins: string[] = []
	const timeouts: number[] = []

	return {
		commands,
		forwarded,
		stdins,
		timeouts,
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
			forwarded.push(port)
			const socket = new PassThrough()
			return { socket, close: () => socket.destroy() }
		},

		exec: async (command: string, timeoutMs?: number, stdin?: string) => {
			if (state !== "ready") throw new Error("Transport is not connected")
			commands.push(command)
			if (timeoutMs !== undefined) timeouts.push(timeoutMs)
			if (stdin !== undefined) stdins.push(stdin)
			const failure = failures.exec?.[command]
			if (failure) throw failure
			return (
				script[command] ?? FAKE_HOST_DEFAULTS[command] ?? { stdout: "", stderr: "", exitCode: 0 }
			)
		},
		close: async () => {
			state = "disconnected"
		},
	}
}

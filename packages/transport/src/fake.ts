import type { ConnectionState, ExecResult, HostTransport } from "./types"

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
): HostTransport & {
	commands: string[]
	stdins: string[]
	timeouts: number[]
} => {
	let state: ConnectionState = "disconnected"
	const commands: string[] = []
	const stdins: string[] = []
	const timeouts: number[] = []

	return {
		commands,
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
		canForward: async () => forwarding,

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

import type { ConnectionState, ExecResult, HostTransport } from "./types"

export type FakeScript = Record<string, ExecResult>

export type FakeFailures = {
	connect?: Error
	exec?: Record<string, Error>
}

export const createFakeTransport = (
	script: FakeScript = {},
	failures: FakeFailures = {},
): HostTransport & {
	commands: string[]
	stdins: string[]
} => {
	let state: ConnectionState = "disconnected"
	const commands: string[] = []
	const stdins: string[] = []

	return {
		commands,
		stdins,
		state: () => state,
		connect: async () => {
			const failure = failures.connect
			if (failure) {
				state = "failed"
				throw failure
			}
			state = "ready"
		},
		exec: async (command: string, _timeoutMs?: number, stdin?: string) => {
			if (state !== "ready") throw new Error("Transport is not connected")
			commands.push(command)
			if (stdin !== undefined) stdins.push(stdin)
			const failure = failures.exec?.[command]
			if (failure) throw failure
			return script[command] ?? { stdout: "", stderr: "", exitCode: 0 }
		},
		close: async () => {
			state = "disconnected"
		},
	}
}

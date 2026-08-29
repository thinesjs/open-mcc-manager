import type { ConnectionState, ExecResult, HostTransport } from "./types"

export type FakeScript = Record<string, ExecResult>

export const createFakeTransport = (
	script: FakeScript = {},
): HostTransport & {
	commands: string[]
} => {
	let state: ConnectionState = "disconnected"
	const commands: string[] = []

	return {
		commands,
		state: () => state,
		connect: async () => {
			state = "ready"
		},
		exec: async (command: string) => {
			commands.push(command)
			return script[command] ?? { stdout: "", stderr: "", exitCode: 0 }
		},
		close: async () => {
			state = "disconnected"
		},
	}
}

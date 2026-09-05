import type { ExecResult } from "../types"

export const MAX_STDOUT_BYTES = 1024 * 1024
export const MAX_STDERR_BYTES = 1024 * 1024
export const DIAGNOSTIC_TAIL_BYTES = 4096

export type ExecStreamName = "stdout" | "stderr"

export class StreamOverflowError extends Error {
	readonly stream: ExecStreamName
	readonly diagnostic: string

	constructor(stream: ExecStreamName, limitBytes: number, diagnostic: string) {
		super(`Command ${stream} exceeded ${limitBytes} bytes and was terminated`)
		this.stream = stream
		this.diagnostic = diagnostic
	}
}

export class ChannelLimitReachedError extends Error {}

const CHANNEL_EXHAUSTION = /open failed|administratively prohibited|resource shortage|too many/i

export const isChannelExhaustion = (error: Error): boolean => CHANNEL_EXHAUSTION.test(error.message)

export const namedChannelError = (error: Error, command: string): Error =>
	isChannelExhaustion(error)
		? new ChannelLimitReachedError(
				`The host refused another session channel, so this command could not run: ${command}. Its MaxSessions limit is likely reached; this is a limit, not an unreachable host`,
			)
		: error

export class CommandAbortedError extends Error {
	readonly signal: string | undefined

	constructor(command: string, signal: string | undefined) {
		super(
			signal === undefined
				? `Command closed without reporting an exit status: ${command}`
				: `Command was terminated by ${signal}: ${command}`,
		)
		this.signal = signal
	}
}

export type ExecChannel = {
	write: (chunk: string) => void
	end: () => void
	onStdout: (listener: (chunk: Buffer) => void) => void
	onStderr: (listener: (chunk: Buffer) => void) => void
	onClose: (
		listener: (exitCode: number | null | undefined, signal: string | undefined) => void,
	) => void
	destroy: () => void
}

const boundedTail = (buffer: Buffer): string => buffer.subarray(-DIAGNOSTIC_TAIL_BYTES).toString()

export const execViaChannel = (
	channel: ExecChannel,
	command: string,
	timeoutMs: number,
	stdin?: string,
): Promise<ExecResult> =>
	new Promise<ExecResult>((resolve, reject) => {
		let settled = false
		let stdout: Buffer = Buffer.alloc(0)
		let stderr: Buffer = Buffer.alloc(0)

		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			channel.destroy()
			reject(new Error(`Command timed out: ${command}`))
		}, timeoutMs)

		const append = (
			current: Buffer,
			chunk: Buffer,
			limitBytes: number,
			streamName: ExecStreamName,
		): Buffer | undefined => {
			const next = Buffer.concat([current, chunk])
			if (next.length <= limitBytes) return next
			if (settled) return undefined
			settled = true
			clearTimeout(timer)
			channel.destroy()
			reject(new StreamOverflowError(streamName, limitBytes, boundedTail(next)))
			return undefined
		}

		channel.onStdout((chunk) => {
			if (settled) return
			const next = append(stdout, chunk, MAX_STDOUT_BYTES, "stdout")
			if (next !== undefined) stdout = next
		})
		channel.onStderr((chunk) => {
			if (settled) return
			const next = append(stderr, chunk, MAX_STDERR_BYTES, "stderr")
			if (next !== undefined) stderr = next
		})
		channel.onClose((exitCode, signal) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (typeof exitCode !== "number") {
				reject(new CommandAbortedError(command, signal))
				return
			}
			resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode })
		})

		if (stdin !== undefined) channel.write(stdin)
		channel.end()
	})

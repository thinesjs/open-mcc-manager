import { Client } from "ssh2"
import { ChannelOpenTimedOutError, ForwardTimedOutError } from "../errors"
import {
	type ConnectionState,
	type ConnectOptions,
	type ExecResult,
	type ForwardedStream,
	type HostTransport,
	LiveChannelUnavailableError,
} from "../types"
import { type ExecChannel, execViaChannel, namedChannelError } from "./exec"
import { createChannelLimiter, DEFAULT_EXEC_CONCURRENCY } from "./limiter"
import { verifyHostKey } from "./verify"

export type RequestChannel = (
	command: string,
	callback: (error: Error | undefined, channel: ExecChannel | undefined) => void,
) => void

export const execWithBoundedAcquisition = (
	requestChannel: RequestChannel,
	command: string,
	timeoutMs: number,
	stdin?: string,
): Promise<ExecResult> =>
	new Promise<ExecResult>((resolve, reject) => {
		let settled = false
		const startedAt = Date.now()
		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			reject(new ChannelOpenTimedOutError(`Command timed out waiting for a channel: ${command}`))
		}, timeoutMs)

		requestChannel(command, (error, channel) => {
			if (settled) {
				channel?.destroy()
				return
			}
			clearTimeout(timer)
			if (error || !channel) {
				settled = true
				reject(
					error
						? namedChannelError(error, command)
						: new Error(`Failed to open a channel for: ${command}`),
				)
				return
			}
			const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt))
			execViaChannel(channel, command, remainingMs, stdin).then(
				(result) => {
					settled = true
					resolve(result)
				},
				(channelError) => {
					settled = true
					reject(channelError)
				},
			)
		})
	})

export const createSshTransport = (): HostTransport => {
	let client: Client | undefined
	let state: ConnectionState = "disconnected"
	const limiter = createChannelLimiter(DEFAULT_EXEC_CONCURRENCY)

	return {
		state: () => state,

		connect: (options: ConnectOptions) =>
			new Promise<void>((resolve, reject) => {
				state = "connecting"
				const conn = new Client()
				const timer = setTimeout(() => {
					state = "failed"
					conn.destroy()
					reject(new Error(`Connection to ${options.hostname} timed out`))
				}, options.timeoutMs)

				const fail = (error: Error) => {
					clearTimeout(timer)
					state = "failed"
					conn.destroy()
					reject(error)
				}

				conn
					.on("ready", () => {
						clearTimeout(timer)
						client = conn
						state = "ready"
						resolve()
					})
					.on("error", fail)

				try {
					conn.connect({
						host: options.hostname,
						port: options.port,
						username: options.username,
						privateKey: options.privateKey,
						readyTimeout: options.timeoutMs,
						hostVerifier: (key: Buffer) => {
							const result = verifyHostKey(key, options.expectedFingerprint)
							return result.ok
						},
					})
				} catch (error) {
					fail(error instanceof Error ? error : new Error("Connection failed"))
				}
			}),

		canForward: (port: number, timeoutMs: number) =>
			new Promise<boolean>((resolve) => {
				const conn = client
				if (!conn) return resolve(false)
				let settled = false
				const settle = (allowed: boolean) => {
					if (settled) return
					settled = true
					clearTimeout(timer)
					resolve(allowed)
				}
				const timer = setTimeout(() => settle(false), timeoutMs)
				conn.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, stream) => {
					if (error) return settle(false)
					stream.on("error", () => settle(false))
					stream.end()
					settle(true)
				})
			}),

		forward: (port: number, timeoutMs: number) =>
			new Promise<ForwardedStream>((resolve, reject) => {
				const conn = client
				if (!conn) return reject(new Error("Transport is not connected"))
				let settled = false
				const timer = setTimeout(() => {
					if (settled) return
					settled = true
					reject(new ForwardTimedOutError(`Forwarding to port ${port} timed out`))
				}, timeoutMs)
				conn.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, stream) => {
					if (settled) {
						stream?.destroy()
						return
					}
					settled = true
					clearTimeout(timer)
					if (error) {
						reject(
							new LiveChannelUnavailableError(
								namedChannelError(error, `forward to ${port}`).message,
							),
						)
						return
					}
					resolve({ socket: stream, close: () => stream.destroy() })
				})
			}),

		exec: async (command: string, timeoutMs: number, stdin?: string) => {
			const conn = client
			if (!conn) throw new Error("Transport is not connected")
			await limiter.acquire()
			try {
				return await execWithBoundedAcquisition(
					(cmd, callback) =>
						conn.exec(cmd, (error, stream) => {
							if (error) {
								callback(error, undefined)
								return
							}
							callback(undefined, {
								write: (chunk) => {
									stream.write(chunk)
								},
								end: () => {
									stream.end()
								},
								onStdout: (listener) => {
									stream.on("data", listener)
								},
								onStderr: (listener) => {
									stream.stderr.on("data", listener)
								},
								onClose: (listener) => {
									stream.on("close", listener)
								},
								destroy: () => {
									stream.destroy()
								},
							})
						}),
					command,
					timeoutMs,
					stdin,
				)
			} finally {
				limiter.release()
			}
		},

		close: async () => {
			client?.end()
			client = undefined
			state = "disconnected"
		},
	}
}

import { Client } from "ssh2"
import type { ConnectionState, ConnectOptions, ExecResult, HostTransport } from "../types"
import { type ExecChannel, execViaChannel } from "./exec"
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
			reject(new Error(`Command timed out waiting for a channel: ${command}`))
		}, timeoutMs)

		requestChannel(command, (error, channel) => {
			if (settled) {
				channel?.destroy()
				return
			}
			clearTimeout(timer)
			if (error || !channel) {
				settled = true
				reject(error ?? new Error(`Failed to open a channel for: ${command}`))
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

		exec: (command: string, timeoutMs: number, stdin?: string) => {
			const conn = client
			if (!conn) return Promise.reject(new Error("Transport is not connected"))
			return execWithBoundedAcquisition(
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
		},

		close: async () => {
			client?.end()
			client = undefined
			state = "disconnected"
		},
	}
}

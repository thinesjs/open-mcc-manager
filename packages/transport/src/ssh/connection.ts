import { Client } from "ssh2"
import type { ConnectionState, ConnectOptions, ExecResult, HostTransport } from "../types"
import { verifyHostKey } from "./verify"

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

				conn
					.on("ready", () => {
						clearTimeout(timer)
						client = conn
						state = "ready"
						resolve()
					})
					.on("error", (error: Error) => {
						clearTimeout(timer)
						state = "failed"
						reject(error)
					})
					.connect({
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
			}),

		exec: (command: string, timeoutMs: number) =>
			new Promise<ExecResult>((resolve, reject) => {
				const conn = client
				if (!conn) {
					reject(new Error("Transport is not connected"))
					return
				}
				conn.exec(command, (error, stream) => {
					if (error) {
						reject(error)
						return
					}
					let stdout = ""
					let stderr = ""
					const timer = setTimeout(() => {
						stream.close()
						reject(new Error(`Command timed out: ${command}`))
					}, timeoutMs)

					stream
						.on("data", (chunk: Buffer) => {
							stdout += chunk.toString()
						})
						.on("close", (exitCode: number) => {
							clearTimeout(timer)
							resolve({ stdout, stderr, exitCode: exitCode ?? 0 })
						})
					stream.stderr.on("data", (chunk: Buffer) => {
						stderr += chunk.toString()
					})
				})
			}),

		close: async () => {
			client?.end()
			client = undefined
			state = "disconnected"
		},
	}
}

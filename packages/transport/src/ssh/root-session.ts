import { Client, type ClientChannel } from "ssh2"
import type { ExecResult } from "../types"
import { type ExecChannel, execViaChannel, namedChannelError } from "./exec"
import { verifyHostKey } from "./verify"

export type RootCredential =
	| { readonly kind: "password"; readonly password: string }
	| { readonly kind: "key"; readonly privateKey: string }

export type RootSessionOptions = {
	readonly hostname: string
	readonly port: number
	readonly username: string
	readonly credential: RootCredential
	readonly expectedFingerprint: string
	readonly timeoutMs: number
}

export type RootClientSettings = {
	readonly host: string
	readonly port: number
	readonly username: string
	readonly readyTimeout: number
	readonly hostVerifier: (key: Buffer) => boolean
} & ({ readonly password: string } | { readonly privateKey: string })

export type RootClient = {
	onReady: (listener: () => void) => void
	onError: (listener: (error: Error) => void) => void
	connect: (settings: RootClientSettings) => void
	exec: (
		command: string,
		callback: (error: Error | undefined, channel: ExecChannel | undefined) => void,
	) => void
	destroy: () => void
}

export type RootSession = {
	connect: (options: RootSessionOptions) => Promise<void>
	run: (command: string, timeoutMs: number) => Promise<ExecResult>
	close: () => void
}

const channelFrom = (stream: ClientChannel): ExecChannel => ({
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

export const sshRootClient = (): RootClient => {
	const client = new Client()
	return {
		onReady: (listener) => {
			client.on("ready", listener)
		},
		onError: (listener) => {
			client.on("error", listener)
		},
		connect: (settings) => {
			client.connect(settings)
		},
		exec: (command, callback) => {
			client.exec(command, (error, stream) => {
				if (error) {
					callback(error, undefined)
					return
				}
				callback(undefined, channelFrom(stream))
			})
		},
		destroy: () => {
			client.destroy()
		},
	}
}

export class RootHostKeyRejectedError extends Error {}

export const SETUP_SCRIPT_LABEL = "the setup script"

const settingsFor = (
	options: RootSessionOptions,
	hostVerifier: (key: Buffer) => boolean,
): RootClientSettings => {
	const shared = {
		host: options.hostname,
		port: options.port,
		username: options.username,
		readyTimeout: options.timeoutMs,
		hostVerifier,
	}
	return options.credential.kind === "password"
		? { ...shared, password: options.credential.password }
		: { ...shared, privateKey: options.credential.privateKey }
}

export const createRootSession = (makeClient: () => RootClient = sshRootClient): RootSession => {
	let client: RootClient | undefined

	return {
		connect: (options) =>
			new Promise<void>((resolve, reject) => {
				const conn = makeClient()
				client = conn
				let settled = false
				let rejectedKey = false

				const settle = (outcome: () => void): void => {
					if (settled) return
					settled = true
					clearTimeout(timer)
					outcome()
				}

				const timer = setTimeout(() => {
					settle(() => {
						conn.destroy()
						client = undefined
						reject(new Error(`Connection to ${options.hostname} timed out`))
					})
				}, options.timeoutMs)

				conn.onReady(() => settle(resolve))
				conn.onError((error) =>
					settle(() => {
						conn.destroy()
						client = undefined
						reject(
							rejectedKey
								? new RootHostKeyRejectedError(
										`The host key of ${options.hostname} did not match the confirmed fingerprint`,
									)
								: error,
						)
					}),
				)

				try {
					conn.connect(
						settingsFor(options, (key: Buffer) => {
							const matched = verifyHostKey(key, options.expectedFingerprint).ok
							if (!matched) rejectedKey = true
							return matched
						}),
					)
				} catch (error) {
					settle(() => {
						conn.destroy()
						client = undefined
						reject(error instanceof Error ? error : new Error("Connection failed"))
					})
				}
			}),

		run: (command, timeoutMs) =>
			new Promise<ExecResult>((resolve, reject) => {
				const conn = client
				if (!conn) {
					reject(new Error("The root session is not connected"))
					return
				}
				conn.exec(command, (error, channel) => {
					if (error || !channel) {
						reject(
							error
								? namedChannelError(error, SETUP_SCRIPT_LABEL)
								: new Error("Failed to open a channel for the setup script"),
						)
						return
					}
					execViaChannel(channel, SETUP_SCRIPT_LABEL, timeoutMs).then(resolve, reject)
				})
			}),

		close: () => {
			const conn = client
			client = undefined
			conn?.destroy()
		},
	}
}

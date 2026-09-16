import { Client } from "ssh2"

export type SshHandshake =
	| { readonly kind: "key"; readonly key: Buffer }
	| { readonly kind: "timed-out" }
	| { readonly kind: "failed"; readonly error: Error }
	| { readonly kind: "closed" }

export const probeSshHandshake = (
	hostname: string,
	port: number,
	timeoutMs: number,
): Promise<SshHandshake> =>
	new Promise<SshHandshake>((resolve) => {
		const conn = new Client()
		let captured: Buffer | undefined
		let failure: Error | undefined
		const timer = setTimeout(() => {
			conn.destroy()
			resolve({ kind: "timed-out" })
		}, timeoutMs)

		const finish = (): void => {
			clearTimeout(timer)
			conn.destroy()
			if (captured) resolve({ kind: "key", key: captured })
			else if (failure) resolve({ kind: "failed", error: failure })
			else resolve({ kind: "closed" })
		}

		conn
			.on("error", (error: Error) => {
				failure = error
				finish()
			})
			.on("close", finish)
			.connect({
				host: hostname,
				port,
				username: "probe",
				readyTimeout: timeoutMs,
				hostVerifier: (key: Buffer) => {
					captured = Buffer.from(key)
					return false
				},
			})
	})

export const probeHostKey = async (
	hostname: string,
	port: number,
	timeoutMs: number,
): Promise<Buffer> => {
	const handshake = await probeSshHandshake(hostname, port, timeoutMs)
	if (handshake.kind === "key") return handshake.key
	if (handshake.kind === "timed-out") {
		throw new Error(`Timed out reading host key from ${hostname}:${port}`)
	}
	throw new Error(`No host key offered by ${hostname}:${port}`)
}

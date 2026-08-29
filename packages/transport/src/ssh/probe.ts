import { Client } from "ssh2"

export const probeHostKey = (hostname: string, port: number, timeoutMs: number): Promise<Buffer> =>
	new Promise<Buffer>((resolve, reject) => {
		const conn = new Client()
		let captured: Buffer | undefined
		const timer = setTimeout(() => {
			conn.destroy()
			reject(new Error(`Timed out reading host key from ${hostname}:${port}`))
		}, timeoutMs)

		const finish = (): void => {
			clearTimeout(timer)
			conn.destroy()
			if (captured) resolve(captured)
			else reject(new Error(`No host key offered by ${hostname}:${port}`))
		}

		conn
			.on("error", () => {
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

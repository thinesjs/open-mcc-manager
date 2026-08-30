import { Client } from "pg"

const LOCK_KEY = 774_411_902

export type SingletonLock = {
	acquired: boolean
	onLost: (handler: () => void) => void
	release: () => Promise<void>
}

export const acquireSingletonLock = async (url: string): Promise<SingletonLock> => {
	const client = new Client({ connectionString: url, keepAlive: true })
	await client.connect()

	const result = await client.query<{ locked: boolean }>({
		text: "SELECT pg_try_advisory_lock($1) AS locked",
		values: [LOCK_KEY],
	})
	const acquired = result.rows[0]?.locked === true

	let lostHandler: (() => void) | undefined
	let lost = false
	let releasing = false

	const reportLost = (): void => {
		if (!acquired || lost || releasing) return
		lost = true
		lostHandler?.()
	}

	client.on("error", reportLost)
	client.on("end", reportLost)

	return {
		acquired,
		onLost: (handler) => {
			lostHandler = handler
			if (lost) handler()
		},
		release: async () => {
			releasing = true
			if (acquired) {
				try {
					await client.query({ text: "SELECT pg_advisory_unlock($1)", values: [LOCK_KEY] })
				} catch {
					console.error("release: connection already lost; nothing left to unlock")
				}
			}
			try {
				await client.end()
			} catch {
				console.error("release: client was already disconnected")
			}
		},
	}
}

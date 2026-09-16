import type { Logger } from "@open-mcc/core"
import { Client } from "pg"

const LOCK_KEY = 774_411_902

export const SINGLETON_APPLICATION_NAME = "open-mcc-singleton"

export type SingletonLock = {
	acquired: boolean
	onLost: (handler: () => void) => void
	release: () => Promise<void>
}

export const acquireSingletonLock = async (url: string, logger: Logger): Promise<SingletonLock> => {
	const client = new Client({
		connectionString: url,
		keepAlive: true,
		application_name: SINGLETON_APPLICATION_NAME,
	})
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
					logger.warn("release: connection already lost; nothing left to unlock")
				}
			}
			try {
				await client.end()
			} catch {
				logger.warn("release: client was already disconnected")
			}
		},
	}
}

import postgres from "postgres"

const LOCK_KEY = 774_411_902

export type SingletonLock = {
	acquired: boolean
	onLost: (handler: () => void) => void
	release: () => Promise<void>
}

export const acquireSingletonLock = async (url: string): Promise<SingletonLock> => {
	const sql = postgres(url, { max: 1, idle_timeout: 0 })
	const rows = await sql<{ locked: boolean }[]>`
		SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked
	`
	const acquired = rows[0]?.locked === true
	let lostHandler: (() => void) | undefined

	if (acquired) {
		const heartbeat = setInterval(() => {
			sql`SELECT 1`.catch(() => {
				clearInterval(heartbeat)
				lostHandler?.()
			})
		}, 5_000)
		heartbeat.unref()
	}

	return {
		acquired,
		onLost: (handler) => {
			lostHandler = handler
		},
		release: async () => {
			if (acquired) await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`
			await sql.end({ timeout: 5 })
		},
	}
}

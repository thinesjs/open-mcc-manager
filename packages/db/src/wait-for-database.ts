import { sql } from "kysely"
import type { Db } from "./client"

export const CONNECT_ATTEMPTS = 15

export const CONNECT_DELAY_MS = 2000

const UNREACHABLE = "the database did not accept a connection in time"

export type WaitDeps = {
	readonly attempts?: number
	readonly delayMs?: number
	readonly probe?: (db: Db) => Promise<void>
	readonly pause?: (ms: number) => Promise<void>
	readonly onRetry?: (attempt: number, attempts: number) => void
}

const defaultProbe = async (db: Db): Promise<void> => {
	await sql`select 1`.execute(db)
}

const defaultPause = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms))

export const waitForDatabase = async (db: Db, deps: WaitDeps = {}): Promise<void> => {
	const attempts = deps.attempts ?? CONNECT_ATTEMPTS
	const delayMs = deps.delayMs ?? CONNECT_DELAY_MS
	const probe = deps.probe ?? defaultProbe
	const pause = deps.pause ?? defaultPause
	const onRetry =
		deps.onRetry ??
		((attempt, total) => {
			console.error(`database not ready yet, attempt ${attempt} of ${total}`)
		})

	let last: Error | undefined

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			await probe(db)
			return
		} catch (error) {
			last = error instanceof Error ? error : new Error(UNREACHABLE)
			if (attempt === attempts) break
			onRetry(attempt, attempts)
			await pause(delayMs)
		}
	}

	throw new Error(UNREACHABLE, last === undefined ? {} : { cause: last })
}

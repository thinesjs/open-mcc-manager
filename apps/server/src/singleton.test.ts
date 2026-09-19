import { randomUUID } from "node:crypto"
import { createLogger } from "@open-mcc/core"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { acquireSingletonLock, SINGLETON_APPLICATION_NAME } from "./singleton"

const silent = createLogger({ write: () => undefined })

const url = process.env.TEST_DATABASE_URL ?? ""
const LOCK_KEY = 774_411_902

const HOLDERS = `SELECT held.pid
	FROM pg_locks AS held
	JOIN pg_stat_activity AS backend ON backend.pid = held.pid
	WHERE held.locktype = 'advisory'
		AND held.granted = true
		AND ((held.classid::bigint << 32) | held.objid::bigint) = $1
		AND backend.application_name = $2
		AND backend.datname = current_database()`

const withInspector = async <T>(
	databaseUrl: string,
	fn: (inspector: Client) => Promise<T>,
): Promise<T> => {
	const inspector = new Client({ connectionString: databaseUrl })
	await inspector.connect()
	try {
		return await fn(inspector)
	} finally {
		await inspector.end()
	}
}

const singletonBackendPids = (databaseUrl: string): Promise<readonly number[]> =>
	withInspector(databaseUrl, async (inspector) => {
		const result = await inspector.query<{ pid: number }>({
			text: HOLDERS,
			values: [LOCK_KEY, SINGLETON_APPLICATION_NAME],
		})
		return result.rows.map((row) => row.pid)
	})

const findHoldingBackendPid = async (): Promise<number | undefined> =>
	(await singletonBackendPids(url))[0]

const terminateBackend = (pid: number): Promise<void> =>
	withInspector(url, async (inspector) => {
		await inspector.query("SELECT pg_terminate_backend($1)", [pid])
	})

const neighbourName = `singleton_neighbour_${randomUUID().replace(/-/g, "")}`

const neighbourUrl = ((): string => {
	const parsed = new URL(url)
	parsed.pathname = `/${neighbourName}`
	return parsed.toString()
})()

const waitFor = <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> =>
	Promise.race([
		promise,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
	])

describe("acquireSingletonLock", () => {
	it("grants the lock to the first holder", async () => {
		const lock = await acquireSingletonLock(url, silent)
		expect(lock.acquired).toBe(true)
		await lock.release()
	})

	it("refuses a second concurrent holder", async () => {
		const first = await acquireSingletonLock(url, silent)
		const second = await acquireSingletonLock(url, silent)
		expect(first.acquired).toBe(true)
		expect(second.acquired).toBe(false)
		await first.release()
		await second.release()
	})

	it("frees the lock after release so a successor can take it", async () => {
		const first = await acquireSingletonLock(url, silent)
		await first.release()
		const second = await acquireSingletonLock(url, silent)
		expect(second.acquired).toBe(true)
		await second.release()
	})

	it("release() on a live lock logs nothing", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const lock = await acquireSingletonLock(url, silent)
		expect(lock.acquired).toBe(true)
		await lock.release()
		expect(errorSpy).not.toHaveBeenCalled()
		expect(warnSpy).not.toHaveBeenCalled()
		errorSpy.mockRestore()
		warnSpy.mockRestore()
	})
})

describe("the backend the loss-detection tests terminate", () => {
	beforeAll(async () => {
		await withInspector(url, async (inspector) => {
			await inspector.query(`create database "${neighbourName}"`)
		})
	})

	afterAll(async () => {
		await withInspector(url, async (inspector) => {
			await inspector.query(`drop database if exists "${neighbourName}" with (force)`)
		})
	})

	it("is never another session holding the same advisory key under a different name", async () => {
		const stranger = new Client({ connectionString: url, application_name: "not-the-singleton" })
		await stranger.connect()
		try {
			await stranger.query("SELECT pg_advisory_lock(0, $1)", [LOCK_KEY])
			const strangerPid = (await stranger.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
				.rows[0]?.pid
			expect(strangerPid).toBeDefined()

			const lock = await acquireSingletonLock(url, silent)
			expect(lock.acquired).toBe(true)
			try {
				const held = await singletonBackendPids(url)
				expect(held).toHaveLength(1)
				expect(held).not.toContain(strangerPid)
			} finally {
				await lock.release()
			}
		} finally {
			await stranger.end()
		}
	})

	it("is never another deployment's singleton on another database of the same server", async () => {
		const neighbour = await acquireSingletonLock(neighbourUrl, silent)
		expect(neighbour.acquired).toBe(true)
		try {
			const lock = await acquireSingletonLock(url, silent)
			expect(lock.acquired).toBe(true)
			try {
				const here = await singletonBackendPids(url)
				const there = await singletonBackendPids(neighbourUrl)
				expect(here).toHaveLength(1)
				expect(there).toHaveLength(1)
				expect(here).not.toEqual(there)
			} finally {
				await lock.release()
			}
		} finally {
			await neighbour.release()
		}
	})
})

describe("acquireSingletonLock loss detection", () => {
	it("fires onLost when the holding backend is terminated externally, and a new instance can then acquire", async () => {
		const lock = await acquireSingletonLock(url, silent)
		expect(lock.acquired).toBe(true)

		const pid = await findHoldingBackendPid()
		if (pid === undefined)
			throw new Error("test setup: could not find the backend holding the lock")

		const lost = new Promise<void>((resolve) => lock.onLost(resolve))

		await terminateBackend(pid)

		await waitFor(lost, 5_000, "onLost did not fire after the holding backend was terminated")

		const second = await acquireSingletonLock(url, silent)
		expect(second.acquired).toBe(true)
		await second.release()

		await lock.release()
	})

	it("warns rather than errors when its backend died and there is nothing left to unlock", async () => {
		const lines: string[] = []
		const capturing = createLogger({ level: "debug", write: (line) => lines.push(line) })
		const lock = await acquireSingletonLock(url, capturing)
		expect(lock.acquired).toBe(true)

		const pid = await findHoldingBackendPid()
		expect(pid).toBeDefined()
		if (pid !== undefined) await terminateBackend(pid)

		await lock.release()

		const warned = lines.map((line) => JSON.parse(line))
		expect(warned.length).toBeGreaterThan(0)
		expect(warned[0]?.level).toBe("warn")
		expect(String(warned[0]?.message)).toContain("nothing left to unlock")
	})
})

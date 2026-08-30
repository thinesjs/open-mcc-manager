import { Client } from "pg"
import { describe, expect, it, vi } from "vitest"
import { acquireSingletonLock } from "./singleton"

const url = process.env.TEST_DATABASE_URL ?? ""
const LOCK_KEY = 774_411_902

const withInspector = async <T>(fn: (inspector: Client) => Promise<T>): Promise<T> => {
	const inspector = new Client({ connectionString: url })
	await inspector.connect()
	try {
		return await fn(inspector)
	} finally {
		await inspector.end()
	}
}

const findHoldingBackendPid = (): Promise<number | undefined> =>
	withInspector(async (inspector) => {
		const result = await inspector.query<{ pid: number }>({
			text: "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted = true AND ((classid::bigint << 32) | objid::bigint) = $1",
			values: [LOCK_KEY],
		})
		return result.rows[0]?.pid
	})

const terminateBackend = (pid: number): Promise<void> =>
	withInspector(async (inspector) => {
		await inspector.query("SELECT pg_terminate_backend($1)", [pid])
	})

const waitFor = <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> =>
	Promise.race([
		promise,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
	])

describe("acquireSingletonLock", () => {
	it("grants the lock to the first holder", async () => {
		const lock = await acquireSingletonLock(url)
		expect(lock.acquired).toBe(true)
		await lock.release()
	})

	it("refuses a second concurrent holder", async () => {
		const first = await acquireSingletonLock(url)
		const second = await acquireSingletonLock(url)
		expect(first.acquired).toBe(true)
		expect(second.acquired).toBe(false)
		await first.release()
		await second.release()
	})

	it("frees the lock after release so a successor can take it", async () => {
		const first = await acquireSingletonLock(url)
		await first.release()
		const second = await acquireSingletonLock(url)
		expect(second.acquired).toBe(true)
		await second.release()
	})

	it("release() on a live lock logs nothing", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const lock = await acquireSingletonLock(url)
		expect(lock.acquired).toBe(true)
		await lock.release()
		expect(errorSpy).not.toHaveBeenCalled()
		expect(warnSpy).not.toHaveBeenCalled()
		errorSpy.mockRestore()
		warnSpy.mockRestore()
	})
})

describe("acquireSingletonLock loss detection", () => {
	it("fires onLost when the holding backend is terminated externally, and a new instance can then acquire", async () => {
		const lock = await acquireSingletonLock(url)
		expect(lock.acquired).toBe(true)

		const pid = await findHoldingBackendPid()
		if (pid === undefined)
			throw new Error("test setup: could not find the backend holding the lock")

		const lost = new Promise<void>((resolve) => lock.onLost(resolve))

		await terminateBackend(pid)

		await waitFor(lost, 5_000, "onLost did not fire after the holding backend was terminated")

		const second = await acquireSingletonLock(url)
		expect(second.acquired).toBe(true)
		await second.release()

		await lock.release()
	})
})

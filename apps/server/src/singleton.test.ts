import { describe, expect, it } from "vitest"
import { acquireSingletonLock } from "./singleton"

const url = process.env.TEST_DATABASE_URL ?? ""

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
})

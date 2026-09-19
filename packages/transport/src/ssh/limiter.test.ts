import { describe, expect, it } from "vitest"
import { createChannelLimiter, DEFAULT_EXEC_CONCURRENCY } from "./limiter"

describe("bounding how many session channels are open at once", () => {
	it("lets work through up to the limit without waiting", async () => {
		const limiter = createChannelLimiter(2)

		await limiter.acquire()
		await limiter.acquire()

		expect(limiter.active()).toBe(2)
		expect(limiter.queued()).toBe(0)
	})

	it("queues past the limit rather than opening a channel the host would refuse", async () => {
		const limiter = createChannelLimiter(1)
		await limiter.acquire()
		let admitted = false
		const pending = limiter.acquire().then(() => {
			admitted = true
		})

		expect(limiter.queued()).toBe(1)
		expect(admitted).toBe(false)

		limiter.release()
		await pending
		expect(admitted).toBe(true)
		expect(limiter.active()).toBe(1)
	})

	it("admits waiters in the order they arrived", async () => {
		const limiter = createChannelLimiter(1)
		await limiter.acquire()
		const order: number[] = []
		const first = limiter.acquire().then(() => order.push(1))
		const second = limiter.acquire().then(() => order.push(2))

		limiter.release()
		await first
		limiter.release()
		await second

		expect(order).toEqual([1, 2])
	})

	it("stays well under the ten channels a default sshd allows", () => {
		expect(DEFAULT_EXEC_CONCURRENCY).toBeLessThan(10)
	})
})

describe("giving up on a wait for a channel", () => {
	it("rejects a waiter that gives up, with the reason it gave", async () => {
		const limiter = createChannelLimiter(1)
		await limiter.acquire()
		const giveUp = new AbortController()
		const reason = new Error("the read ran out of time")

		const waiting = limiter.acquire(giveUp.signal)
		giveUp.abort(reason)

		await expect(waiting).rejects.toBe(reason)
	})

	it("takes a waiter that gave up out of the queue, so a freed slot is not handed to nobody", async () => {
		const limit = 6
		const limiter = createChannelLimiter(limit)
		for (let held = 0; held < limit; held += 1) await limiter.acquire()
		const giveUp = new AbortController()
		const abandoned = limiter.acquire(giveUp.signal).catch(() => "abandoned")

		giveUp.abort(new Error("expired"))
		expect(await abandoned).toBe("abandoned")
		for (let held = 0; held < limit; held += 1) limiter.release()

		expect(limiter.active()).toBe(0)
		expect(limiter.queued()).toBe(0)
		const admitted = await Promise.race([
			Promise.all(Array.from({ length: limit }, () => limiter.acquire())).then(() => "admitted"),
			new Promise((resolve) => setImmediate(() => resolve("still waiting"))),
		])
		expect(admitted).toBe("admitted")
		expect(limiter.active()).toBe(limit)
	})

	it("refuses at once a wait that was already given up", async () => {
		const limiter = createChannelLimiter(1)
		const giveUp = new AbortController()
		giveUp.abort(new Error("gone"))

		await expect(limiter.acquire(giveUp.signal)).rejects.toThrow("gone")
		expect(limiter.active()).toBe(0)
	})
})

import { afterAll, describe, expect, it } from "vitest"
import { createDb } from "./client"
import { CONNECT_ATTEMPTS, waitForDatabase } from "./wait-for-database"

const noDb = createDb("postgres://unused@127.0.0.1:1/none")

afterAll(async () => {
	await noDb.destroy()
})

describe("waiting for a database that is coming up", () => {
	it("returns as soon as it answers, without pausing", async () => {
		let pauses = 0

		await waitForDatabase(noDb, {
			probe: async () => undefined,
			pause: async () => {
				pauses += 1
			},
			onRetry: () => undefined,
		})

		expect(pauses).toBe(0)
	})

	it("keeps trying while it is not ready yet, then succeeds", async () => {
		let probes = 0
		const pauses: number[] = []

		await waitForDatabase(noDb, {
			delayMs: 50,
			probe: async () => {
				probes += 1
				if (probes < 3) throw new Error("ECONNREFUSED")
			},
			pause: async (ms) => {
				pauses.push(ms)
			},
			onRetry: () => undefined,
		})

		expect(probes).toBe(3)
		expect(pauses).toEqual([50, 50])
	})

	it("gives up after a bounded number of attempts rather than hanging", async () => {
		let probes = 0

		await expect(
			waitForDatabase(noDb, {
				attempts: 4,
				probe: async () => {
					probes += 1
					throw new Error("ECONNREFUSED")
				},
				pause: async () => undefined,
				onRetry: () => undefined,
			}),
		).rejects.toThrow("the database did not accept a connection in time")

		expect(probes).toBe(4)
	})

	it("pauses one time fewer than it probes, so it never waits after the last try", async () => {
		let pauses = 0

		await expect(
			waitForDatabase(noDb, {
				attempts: 3,
				probe: async () => {
					throw new Error("ECONNREFUSED")
				},
				pause: async () => {
					pauses += 1
				},
				onRetry: () => undefined,
			}),
		).rejects.toThrow()

		expect(pauses).toBe(2)
	})

	it("keeps the real failure as the cause, so a wrong address is still diagnosable", async () => {
		const underlying = new Error("getaddrinfo ENOTFOUND nope.invalid")

		try {
			await waitForDatabase(noDb, {
				attempts: 1,
				probe: async () => {
					throw underlying
				},
				pause: async () => undefined,
				onRetry: () => undefined,
			})
			expect.unreachable("should have thrown")
		} catch (error) {
			expect(error instanceof Error && error.cause).toBe(underlying)
		}
	})

	it("bounds the default wait to something a deploy will not sit behind forever", () => {
		expect(CONNECT_ATTEMPTS).toBeLessThanOrEqual(20)
	})
})

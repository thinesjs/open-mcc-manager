import { describe, expect, it, vi } from "vitest"
import {
	boundariesFor,
	createCleanupHandler,
	cutoffFor,
	DEADLETTER_RETENTION_DAYS,
	NOTIFICATION_RETENTION_DAYS,
	TEST_WINDOW_MS,
	TESTS_PER_WINDOW,
	throttleExceeded,
} from "./retention"

describe("how long a notification is kept", () => {
	it("keeps 90 days", () => {
		expect(NOTIFICATION_RETENTION_DAYS).toBe(90)
	})

	it("works out the cutoff from now, not from a fixed date", () => {
		const now = new Date("2026-09-07T12:00:00Z")
		expect(cutoffFor(now).toISOString()).toBe("2026-06-09T12:00:00.000Z")
	})

	it("can be asked for a shorter window", () => {
		const now = new Date("2026-09-07T12:00:00Z")
		expect(cutoffFor(now, 1).toISOString()).toBe("2026-09-06T12:00:00.000Z")
	})

	it("holds a notification back until the dead letter that names its delivery has expired too", () => {
		expect(DEADLETTER_RETENTION_DAYS).toBe(30)
		const boundaries = boundariesFor(new Date("2026-09-07T12:00:00Z"))

		expect(boundaries.createdBefore.toISOString()).toBe("2026-06-09T12:00:00.000Z")
		expect(boundaries.settledBefore.toISOString()).toBe("2026-08-08T12:00:00.000Z")
	})

	it("cleans every organization on its own scope, and reports the whole total", async () => {
		const deleteSettledBefore = vi.fn(async () => 7)
		const clean = createCleanupHandler({
			organizationIds: async () => ["org-a", "org-b"],
			deleteSettledBefore,
			now: () => new Date("2026-09-07T12:00:00Z"),
		})

		expect(await clean()).toBe(14)
		expect(deleteSettledBefore).toHaveBeenCalledTimes(2)
		expect(deleteSettledBefore).toHaveBeenCalledWith(
			{ organizationId: "org-a" },
			{
				createdBefore: new Date("2026-06-09T12:00:00.000Z"),
				settledBefore: new Date("2026-08-08T12:00:00.000Z"),
			},
		)
		expect(deleteSettledBefore).toHaveBeenCalledWith(
			{ organizationId: "org-b" },
			{
				createdBefore: new Date("2026-06-09T12:00:00.000Z"),
				settledBefore: new Date("2026-08-08T12:00:00.000Z"),
			},
		)
	})

	it("deletes nothing when there is no organization to clean", async () => {
		const deleteSettledBefore = vi.fn(async () => 7)
		const clean = createCleanupHandler({
			organizationIds: async () => [],
			deleteSettledBefore,
			now: () => new Date("2026-09-07T12:00:00Z"),
		})

		expect(await clean()).toBe(0)
		expect(deleteSettledBefore).not.toHaveBeenCalled()
	})
})

describe("how often a test may be sent", () => {
	it("allows a few in a minute and then stops", () => {
		expect(TEST_WINDOW_MS).toBe(60_000)
		expect(throttleExceeded(0)).toBe(false)
		expect(throttleExceeded(TESTS_PER_WINDOW - 1)).toBe(false)
		expect(throttleExceeded(TESTS_PER_WINDOW)).toBe(true)
		expect(throttleExceeded(TESTS_PER_WINDOW + 10)).toBe(true)
	})

	it("takes a different limit when asked", () => {
		expect(throttleExceeded(1, 1)).toBe(true)
		expect(throttleExceeded(0, 1)).toBe(false)
	})
})

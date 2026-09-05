import type { InstanceCommandRow } from "@open-mcc/db"
import { describe, expect, it, vi } from "vitest"
import { isDue } from "./due"
import { runSchedulerTick, startScheduler } from "./scheduler"

const row = (overrides: Partial<InstanceCommandRow> = {}): InstanceCommandRow => ({
	id: "cmd-1",
	organizationId: "org-1",
	instanceId: "abc123",
	name: "morning wave",
	command: "/say good morning",
	daysOfWeek: "Mon",
	minuteOfDay: 9 * 60,
	timezone: "UTC",
	enabled: true,
	lastRunAt: null,
	lastRunError: null,
	createdAt: new Date(),
	...overrides,
})

const monday9am = new Date("2026-08-31T09:00:00Z")

const deps = (
	rows: InstanceCommandRow[],
	send = vi.fn(async () => undefined),
	claimRun = vi.fn(async () => true),
) => {
	const recordRun = vi.fn(async () => undefined)
	return {
		send,
		claimRun,
		recordRun,
		dueCommands: async () => rows,
		now: () => monday9am,
	}
}

describe("scheduler tick", () => {
	it("sends a command that is due and records the run", async () => {
		const base = deps([row()])
		const result = await runSchedulerTick(base)

		expect(result.fired).toEqual(["cmd-1"])
		expect(base.send).toHaveBeenCalledTimes(1)
		expect(base.claimRun).toHaveBeenCalled()
	})

	it("leaves a command that is not due alone", async () => {
		const base = deps([row({ minuteOfDay: 23 * 60 })])
		const result = await runSchedulerTick(base)

		expect(result.fired).toEqual([])
		expect(result.skipped).toBe(1)
		expect(base.send).not.toHaveBeenCalled()
		expect(base.recordRun).not.toHaveBeenCalled()
	})

	it("keeps going after one command fails, so a bad host cannot stall the fleet", async () => {
		const send = vi.fn(async (each: InstanceCommandRow) => {
			if (each.id === "cmd-1") throw new Error("Connection refused")
		})
		const base = deps([row(), row({ id: "cmd-2", name: "second" })], send)

		const result = await runSchedulerTick(base)

		expect(result.failed).toEqual([{ id: "cmd-1", reason: "Connection refused" }])
		expect(result.fired).toEqual(["cmd-2"])
	})

	it("records the failure reason so an operator can see why it never ran", async () => {
		const send = vi.fn(async () => {
			throw new Error("Host unreachable")
		})
		const base = deps([row()], send)

		await runSchedulerTick(base)

		expect(base.recordRun).toHaveBeenCalledWith("cmd-1", monday9am, "Host unreachable")
	})

	it("records a bad timezone as a failure rather than throwing out of the tick", async () => {
		const base = deps([row({ timezone: "Mars/Olympus" })])

		const result = await runSchedulerTick(base)

		expect(result.failed[0]?.reason).toContain("Mars/Olympus")
		expect(base.send).not.toHaveBeenCalled()
	})

	it("never sends the same command twice in one tick", async () => {
		const base = deps([row()])
		await runSchedulerTick(base)
		expect(base.send).toHaveBeenCalledTimes(1)
	})
})

describe("scheduler loop", () => {
	it("does not start a second tick while one is still running", async () => {
		vi.useFakeTimers()
		let active = 0
		let overlaps = 0
		const handle = startScheduler(
			{
				dueCommands: async () => {
					active += 1
					if (active > 1) overlaps += 1
					await new Promise((resolve) => setTimeout(resolve, 50))
					active -= 1
					return []
				},
				send: async () => undefined,
				claimRun: async () => true,
				recordRun: async () => undefined,
				now: () => monday9am,
			},
			10,
		)

		await vi.advanceTimersByTimeAsync(100)
		handle.stop()
		vi.useRealTimers()

		expect(overlaps).toBe(0)
	})

	it("stops ticking once stopped", async () => {
		vi.useFakeTimers()
		const dueCommands = vi.fn(async () => [])
		const handle = startScheduler(
			{
				dueCommands,
				send: async () => undefined,
				claimRun: async () => true,
				recordRun: async () => undefined,
				now: () => monday9am,
			},
			10,
		)
		await vi.advanceTimersByTimeAsync(25)
		const before = dueCommands.mock.calls.length
		handle.stop()
		await vi.advanceTimersByTimeAsync(100)
		vi.useRealTimers()

		expect(dueCommands.mock.calls.length).toBe(before)
		expect(before).toBeGreaterThan(0)
	})
})

describe("claiming a run before sending it", () => {
	it("claims before it sends, so a lost record cannot become a resend", async () => {
		const order: string[] = []
		const claimRun = vi.fn(async () => {
			order.push("claim")
			return true
		})
		const send = vi.fn(async () => {
			order.push("send")
		})
		const base = deps([row()], send, claimRun)

		await runSchedulerTick(base)

		expect(order).toEqual(["claim", "send"])
	})

	it("does not send when another worker already claimed the run", async () => {
		const claimRun = vi.fn(async () => false)
		const base = deps(
			[row()],
			vi.fn(async () => undefined),
			claimRun,
		)

		const result = await runSchedulerTick(base)

		expect(base.send).not.toHaveBeenCalled()
		expect(result.unclaimed).toBe(1)
		expect(result.fired).toEqual([])
	})

	it("misses a run rather than repeating it when the database is unreachable", async () => {
		const claimRun = vi.fn(async () => {
			throw new Error("Connection terminated")
		})
		const base = deps(
			[row()],
			vi.fn(async () => undefined),
			claimRun,
		)

		const result = await runSchedulerTick(base)

		expect(base.send).not.toHaveBeenCalled()
		expect(result.failed).toEqual([{ id: "cmd-1", reason: "Connection terminated" }])
	})

	it("claims against the start of the schedule's own local day", async () => {
		const seen: Date[] = []
		const claimRun = vi.fn(async (_id: string, _at: Date, notRunSince: Date) => {
			seen.push(notRunSince)
			return true
		})
		const base = deps(
			[row()],
			vi.fn(async () => undefined),
			claimRun,
		)

		await runSchedulerTick(base)

		expect(seen).toHaveLength(1)
		expect(seen[0]?.getTime()).toBeLessThan(monday9am.getTime())
	})
})

describe("editing a schedule", () => {
	it("does not judge a run against a timezone the schedule no longer uses", () => {
		const ranAt = new Date("2026-08-31T23:00:00Z")
		const inKualaLumpur = {
			daysOfWeek: ["Mon"] as const,
			minuteOfDay: 7 * 60,
			timezone: "Asia/Kuala_Lumpur",
			enabled: true,
			lastRunAt: ranAt,
		}
		const movedToUtc = { ...inKualaLumpur, timezone: "UTC" }

		expect(isDue(inKualaLumpur, new Date("2026-08-31T23:10:00Z"))).toBe(false)
		expect(isDue({ ...movedToUtc, lastRunAt: null }, new Date("2026-08-31T23:10:00Z"))).toBe(false)
	})
})

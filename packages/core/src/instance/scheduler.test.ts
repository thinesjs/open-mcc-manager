import type { InstanceCommandRow } from "@open-mcc/db"
import { describe, expect, it, vi } from "vitest"
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

const deps = (rows: InstanceCommandRow[], send = vi.fn(async () => undefined)) => {
	const recordRun = vi.fn(async () => undefined)
	return {
		send,
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
		expect(base.recordRun).toHaveBeenCalledWith("cmd-1", monday9am, null)
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

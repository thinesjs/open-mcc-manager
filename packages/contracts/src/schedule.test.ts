import { describe, expect, it } from "vitest"
import { scheduledCommandInput, scheduledCommandPublic, sleepWindowInput } from "./schedule"

const window = {
	instanceId: "abc123",
	daysOfWeek: ["Mon"],
	stopAt: { hour: 18, minute: 50 },
	startAt: { hour: 19, minute: 30 },
}

const command = {
	instanceId: "abc123",
	name: "morning wave",
	command: "/say good morning",
	daysOfWeek: ["Mon"],
	runAt: { hour: 9, minute: 0 },
}

const messagesFor = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
	result.error?.issues.map((issue) => issue.message) ?? []

describe("the time zone a schedule runs in", () => {
	it("refuses a sleep window in a zone that has the right shape but does not exist", () => {
		expect(sleepWindowInput.safeParse({ ...window, timezone: "Not/AZone" }).success).toBe(false)
	})

	it("refuses a scheduled command in a zone that has the right shape but does not exist", () => {
		expect(scheduledCommandInput.safeParse({ ...command, timezone: "Not/AZone" }).success).toBe(
			false,
		)
	})

	it("refuses a real zone typed in the wrong letter case, which a host would not find", () => {
		expect(sleepWindowInput.safeParse({ ...window, timezone: "asia/kuala_lumpur" }).success).toBe(
			false,
		)
		expect(
			scheduledCommandInput.safeParse({ ...command, timezone: "asia/kuala_lumpur" }).success,
		).toBe(false)
	})

	it("accepts real zones, including one nested two levels deep and one the engine renames", () => {
		for (const timezone of [
			"UTC",
			"Etc/UTC",
			"Asia/Kuala_Lumpur",
			"America/Argentina/Buenos_Aires",
		]) {
			expect(sleepWindowInput.safeParse({ ...window, timezone }).success, timezone).toBe(true)
			expect(scheduledCommandInput.safeParse({ ...command, timezone }).success, timezone).toBe(true)
		}
	})

	it("accepts an older name a browser may still report as its own zone", () => {
		expect(sleepWindowInput.safeParse({ ...window, timezone: "Asia/Calcutta" }).success).toBe(true)
	})

	it("says what is wrong in plain words", () => {
		const messages = messagesFor(sleepWindowInput.safeParse({ ...window, timezone: "Not/AZone" }))

		expect(messages).toHaveLength(1)
		expect(messages[0]).not.toMatch(/IANA/)
	})
})

const PUBLIC_COMMAND = {
	id: "cmd-1",
	instanceId: "abc123",
	name: "morning wave",
	command: "/say good morning",
	daysOfWeek: ["Mon"],
	runAt: { hour: 9, minute: 0 },
	timezone: "UTC",
	enabled: true,
	lastRunError: null,
}

describe("when a scheduled command last ran, as the wire sends it", () => {
	it("requires the ISO string a JSON response carries, not a Date object", () => {
		expect(scheduledCommandPublic.safeParse({ ...PUBLIC_COMMAND, lastRunAt: new Date() }).success).toBe(
			false,
		)
		expect(
			scheduledCommandPublic.safeParse({
				...PUBLIC_COMMAND,
				lastRunAt: "2026-09-01T09:00:00.000Z",
			}).success,
		).toBe(true)
	})
})

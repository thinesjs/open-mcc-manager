import { describe, expect, it } from "vitest"
import { scheduledCommandInput, sleepWindowInput } from "./schedule"

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

	it("accepts real zones, including one nested two levels deep", () => {
		for (const timezone of ["UTC", "Asia/Kuala_Lumpur", "America/Argentina/Buenos_Aires"]) {
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

import { describe, expect, it } from "vitest"
import {
	COMMAND_SPANS_LINES,
	INSTANCE_COMMAND_MAX_BYTES,
	INVISIBLE_CHARACTER_IN_COMMAND,
	sendInstanceCommandInput,
} from "./instance"
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
		expect(
			scheduledCommandPublic.safeParse({ ...PUBLIC_COMMAND, lastRunAt: new Date() }).success,
		).toBe(false)
		expect(
			scheduledCommandPublic.safeParse({
				...PUBLIC_COMMAND,
				lastRunAt: "2026-09-01T09:00:00.000Z",
			}).success,
		).toBe(true)
	})
})

const TAB = "say\thello"

const TWO_LINES = "say hello\nsay again"

const CARRIAGE_RETURN = "say hello\rsay again"

const COMMANDS = [
	"/say good morning",
	"!reco",
	"//login hunter2",
	TAB,
	TWO_LINES,
	CARRIAGE_RETURN,
	"say hello",
	"say hello",
	"",
	"x".repeat(INSTANCE_COMMAND_MAX_BYTES + 1),
]

const verdictOf = (result: {
	success: boolean
	error?: { issues: { message: string }[] }
}): { success: boolean; messages: string[] } => ({
	success: result.success,
	messages: messagesFor(result),
})

const onSchedule = (text: string) =>
	verdictOf(scheduledCommandInput.safeParse({ ...command, timezone: "UTC", command: text }))

const atConsole = (text: string) =>
	verdictOf(sendInstanceCommandInput.safeParse({ instanceId: "abc123", command: text }))

describe("what this manager takes as a command, at the console and on a schedule", () => {
	it("★ answers alike at both doors, for every command either one is given", () => {
		for (const text of COMMANDS) {
			expect(onSchedule(text), JSON.stringify(text)).toEqual(atConsole(text))
		}
	})

	it("★ reads one definition at both doors rather than two that happen to agree", () => {
		expect(scheduledCommandInput.shape.command).toBe(sendInstanceCommandInput.shape.command)
	})

	it("★ tells a tab apart from a line break, and still takes an ordinary command", () => {
		expect(onSchedule(TAB)).toEqual({ success: false, messages: [INVISIBLE_CHARACTER_IN_COMMAND] })
		expect(onSchedule(TWO_LINES)).toEqual({ success: false, messages: [COMMAND_SPANS_LINES] })
		expect(onSchedule(CARRIAGE_RETURN)).toEqual({ success: false, messages: [COMMAND_SPANS_LINES] })
		expect(onSchedule("/say good morning")).toEqual({ success: true, messages: [] })
	})
})

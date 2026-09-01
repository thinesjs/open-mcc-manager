import { DAYS_OF_WEEK, type DayOfWeek } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import {
	parseDaysOfWeek,
	renderDaysOfWeek,
	renderOnCalendar,
	renderSleepTimers,
	sleepStartTimer,
	sleepStopTimer,
} from "./schedule"

const window = {
	id: "sched-1",
	instanceId: "abc123",
	daysOfWeek: ["Mon", "Tue"] as const,
	stopAt: { hour: 18, minute: 50 },
	startAt: { hour: 19, minute: 30 },
	timezone: "Asia/Kuala_Lumpur",
	enabled: true,
}

describe("sleep window rendering", () => {
	it("renders the operator's stated local time, not a converted one", () => {
		const timers = renderSleepTimers(window)
		expect(timers["open-mcc-sleep-stop@abc123.timer"]).toContain(
			"OnCalendar=Mon,Tue *-*-* 18:50:00 Asia/Kuala_Lumpur",
		)
		expect(timers["open-mcc-sleep-start@abc123.timer"]).toContain(
			"OnCalendar=Mon,Tue *-*-* 19:30:00 Asia/Kuala_Lumpur",
		)
	})

	it("stores a whole week as a single marker rather than seven names", () => {
		expect(renderDaysOfWeek(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])).toBe("*")
	})

	it("omits the weekday for a daily window, which is the form systemd parses", () => {
		expect(renderOnCalendar(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], 1170, "UTC")).toBe(
			"*-*-* 19:30:00 UTC",
		)
	})

	it("never emits a bare asterisk weekday, which systemd rejects as invalid", () => {
		const cases: DayOfWeek[][] = [["Mon"], ["Mon", "Tue"], [...DAYS_OF_WEEK]]
		for (const days of cases) {
			expect(renderOnCalendar(days, 600, "UTC")).not.toMatch(/^\* /)
		}
	})

	it("orders days as systemd expects regardless of the order they arrive in", () => {
		expect(renderDaysOfWeek(["Sat", "Mon", "Fri"])).toBe("Mon,Fri,Sat")
	})

	it("round-trips what it stores", () => {
		expect(parseDaysOfWeek(renderDaysOfWeek(["Wed", "Mon"]))).toEqual(["Mon", "Wed"])
		expect(parseDaysOfWeek("*")).toHaveLength(7)
	})

	it("refuses a timezone that could carry unit-file structure into the timer", () => {
		for (const timezone of [
			"Asia/Kuala_Lumpur\nExecStart=/bin/sh",
			"UTC\n[Service]",
			"../../etc/passwd",
			"UTC;rm -rf /",
		]) {
			expect(() => renderOnCalendar(["Mon"], 600, timezone)).toThrow()
		}
	})

	it("emits exactly one OnCalendar line and one section per timer, whatever the input", () => {
		const unit = renderSleepTimers(window)["open-mcc-sleep-stop@abc123.timer"] ?? ""
		expect(unit.match(/^OnCalendar=/gm)).toHaveLength(1)
		expect(unit.match(/^\[[A-Za-z]+\]$/gm)).toEqual(["[Unit]", "[Timer]", "[Install]"])
	})

	it("builds timer names through the instance-id validator", () => {
		expect(sleepStopTimer("abc123")).toBe("open-mcc-sleep-stop@abc123.timer")
		expect(sleepStartTimer("abc123")).toBe("open-mcc-sleep-start@abc123.timer")
		expect(() => sleepStopTimer("bad%id")).toThrow()
		expect(() => sleepStartTimer("../../etc")).toThrow()
	})
})

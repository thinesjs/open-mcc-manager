import { describe, expect, it } from "vitest"
import { CATCH_UP_GRACE_MINUTES, isDue, UnknownTimezoneError, zonedMoment } from "./due"

const at = (iso: string) => new Date(iso)

const candidate = (overrides: Partial<Parameters<typeof isDue>[0]> = {}) => ({
	daysOfWeek: ["Mon"] as const,
	minuteOfDay: 9 * 60,
	timezone: "UTC",
	enabled: true,
	lastRunAt: null,
	...overrides,
})

describe("zoned moment", () => {
	it("reads the wall clock in the schedule's own timezone, not the server's", () => {
		const utc = zonedMoment(at("2026-09-01T01:30:00Z"), "UTC")
		const kl = zonedMoment(at("2026-09-01T01:30:00Z"), "Asia/Kuala_Lumpur")

		expect(utc.minuteOfDay).toBe(90)
		expect(kl.minuteOfDay).toBe(9 * 60 + 30)
	})

	it("rolls the date and weekday when the zone is a day ahead", () => {
		const moment = zonedMoment(at("2026-09-01T17:00:00Z"), "Pacific/Auckland")
		expect(moment.dateKey).toBe("2026-09-02")
		expect(moment.weekday).toBe("Wed")
	})

	it("refuses a timezone it cannot resolve rather than silently using utc", () => {
		expect(() => zonedMoment(at("2026-09-01T00:00:00Z"), "Mars/Olympus")).toThrow(
			UnknownTimezoneError,
		)
	})
})

describe("due selection", () => {
	it("fires at the scheduled minute on a scheduled day", () => {
		expect(isDue(candidate(), at("2026-08-31T09:00:00Z"))).toBe(true)
	})

	it("does not fire before the scheduled minute", () => {
		expect(isDue(candidate(), at("2026-08-31T08:59:00Z"))).toBe(false)
	})

	it("does not fire on a day it was not scheduled for", () => {
		expect(isDue(candidate(), at("2026-09-01T09:00:00Z"))).toBe(false)
	})

	it("catches up a missed run inside the grace window", () => {
		expect(isDue(candidate(), at("2026-08-31T09:45:00Z"))).toBe(true)
	})

	it("gives up on a run missed by longer than the grace window", () => {
		const past = new Date(
			at("2026-08-31T09:00:00Z").getTime() + (CATCH_UP_GRACE_MINUTES + 1) * 60_000,
		)
		expect(isDue(candidate(), past)).toBe(false)
	})

	it("fires only once a day, however often it is polled", () => {
		const already = candidate({ lastRunAt: at("2026-08-31T09:00:00Z") })
		expect(isDue(already, at("2026-08-31T09:01:00Z"))).toBe(false)
		expect(isDue(already, at("2026-08-31T09:59:00Z"))).toBe(false)
	})

	it("fires again the following week", () => {
		const already = candidate({ lastRunAt: at("2026-08-31T09:00:00Z") })
		expect(isDue(already, at("2026-09-07T09:00:00Z"))).toBe(true)
	})

	it("never fires while disabled", () => {
		expect(isDue(candidate({ enabled: false }), at("2026-08-31T09:00:00Z"))).toBe(false)
	})

	it("uses the schedule's timezone to decide the day, not the server's", () => {
		const kl = candidate({
			daysOfWeek: ["Tue"],
			minuteOfDay: 8 * 60,
			timezone: "Asia/Kuala_Lumpur",
		})
		expect(isDue(kl, at("2026-09-01T00:00:00Z"))).toBe(true)
		expect(zonedMoment(at("2026-09-01T00:00:00Z"), "UTC").weekday).toBe("Tue")
	})

	it("treats the same-day guard in the schedule's timezone, not utc", () => {
		const kl = candidate({
			daysOfWeek: ["Tue"],
			minuteOfDay: 1,
			timezone: "Asia/Kuala_Lumpur",
			lastRunAt: at("2026-09-01T16:01:00Z"),
		})
		expect(isDue(kl, at("2026-09-01T16:20:00Z"))).toBe(false)
	})

	it("still fires across a spring-forward transition, when local time jumps", () => {
		const nyc = candidate({
			daysOfWeek: ["Sun"],
			minuteOfDay: 4 * 60,
			timezone: "America/New_York",
			lastRunAt: null,
		})
		expect(isDue(nyc, at("2026-03-08T08:05:00Z"))).toBe(true)
	})
})

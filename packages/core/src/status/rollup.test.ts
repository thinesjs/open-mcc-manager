import { describe, expect, it } from "vitest"
import {
	addDays,
	bucketOf,
	daysBetween,
	overlapSeconds,
	rollUpDay,
	SECONDS_PER_DAY,
	startOfUtcDay,
} from "./rollup"

const day = new Date(Date.UTC(2026, 8, 6, 0, 0, 0))
const at = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 8, 6, hour, minute, 0))

describe("which bucket a state falls in", () => {
	it("counts a reachable host and a joined bot as good", () => {
		expect(bucketOf("up")).toBe("goodSeconds")
		expect(bucketOf("joined")).toBe("goodSeconds")
	})

	it("counts a bot that never joined as bad, not unknown", () => {
		expect(bucketOf("never_joined")).toBe("badSeconds")
	})

	it("counts a merely suspect host as unknown, so one failed check is not downtime", () => {
		expect(bucketOf("suspect")).toBe("unknownSeconds")
	})

	it("counts an expected stop as excluded, so a sleep window is not held against uptime", () => {
		expect(bucketOf("stopped_expected")).toBe("excludedSeconds")
		expect(bucketOf("excluded")).toBe("excludedSeconds")
	})
})

describe("clipping an interval to one day", () => {
	const dayEnd = addDays(day, 1)

	it("measures an interval that sits inside the day", () => {
		expect(overlapSeconds({ state: "up", startedAt: at(1), endedAt: at(2) }, day, dayEnd)).toBe(
			3_600,
		)
	})

	it("clips an interval that started before the day", () => {
		const previous = new Date(Date.UTC(2026, 8, 5, 22, 0, 0))

		expect(overlapSeconds({ state: "up", startedAt: previous, endedAt: at(1) }, day, dayEnd)).toBe(
			3_600,
		)
	})

	it("treats an interval that is still open as running to the end of the day", () => {
		expect(overlapSeconds({ state: "up", startedAt: at(23), endedAt: null }, day, dayEnd)).toBe(
			3_600,
		)
	})

	it("gives a whole day for an interval that spans it entirely", () => {
		const before = new Date(Date.UTC(2026, 8, 1))
		const after = new Date(Date.UTC(2026, 8, 9))

		expect(overlapSeconds({ state: "up", startedAt: before, endedAt: after }, day, dayEnd)).toBe(
			SECONDS_PER_DAY,
		)
	})

	it("gives nothing for an interval that ended before the day began", () => {
		const before = new Date(Date.UTC(2026, 8, 5, 1, 0, 0))
		const alsoBefore = new Date(Date.UTC(2026, 8, 5, 2, 0, 0))

		expect(
			overlapSeconds({ state: "up", startedAt: before, endedAt: alsoBefore }, day, dayEnd),
		).toBe(0)
	})

	it("gives nothing for a zero-length interval", () => {
		expect(overlapSeconds({ state: "up", startedAt: at(3), endedAt: at(3) }, day, dayEnd)).toBe(0)
	})
})

describe("rolling a day up", () => {
	it("sums each bucket separately", () => {
		const totals = rollUpDay(
			[
				{ state: "up", startedAt: at(0), endedAt: at(20) },
				{ state: "down", startedAt: at(20), endedAt: at(22) },
				{ state: "suspect", startedAt: at(22), endedAt: at(23) },
				{ state: "excluded", startedAt: at(23), endedAt: addDays(day, 1) },
			],
			day,
		)

		expect(totals.goodSeconds).toBe(20 * 3_600)
		expect(totals.badSeconds).toBe(2 * 3_600)
		expect(totals.unknownSeconds).toBe(3_600)
		expect(totals.excludedSeconds).toBe(3_600)
	})

	it("returns an empty day when nothing was recorded, rather than inventing good time", () => {
		expect(rollUpDay([], day)).toEqual({
			goodSeconds: 0,
			badSeconds: 0,
			degradedSeconds: 0,
			unknownSeconds: 0,
			excludedSeconds: 0,
		})
	})

	it("ignores intervals belonging to another day", () => {
		const other = new Date(Date.UTC(2026, 8, 1, 5, 0, 0))
		const otherEnd = new Date(Date.UTC(2026, 8, 1, 6, 0, 0))

		expect(rollUpDay([{ state: "up", startedAt: other, endedAt: otherEnd }], day).goodSeconds).toBe(
			0,
		)
	})
})

describe("choosing which days to roll", () => {
	it("lists whole days between two moments and excludes the day still in progress", () => {
		const from = new Date(Date.UTC(2026, 8, 1, 13, 0, 0))
		const until = new Date(Date.UTC(2026, 8, 4, 9, 0, 0))

		expect(daysBetween(from, until).map((d) => d.toISOString())).toEqual([
			"2026-09-01T00:00:00.000Z",
			"2026-09-02T00:00:00.000Z",
			"2026-09-03T00:00:00.000Z",
		])
	})

	it("lists nothing when both moments fall on the same day", () => {
		expect(daysBetween(at(1), at(23))).toEqual([])
	})

	it("normalises any moment to the start of its UTC day", () => {
		expect(startOfUtcDay(at(17, 45)).toISOString()).toBe("2026-09-06T00:00:00.000Z")
	})
})

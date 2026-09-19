import { BUCKET_SECONDS, RANGE_SECONDS, STATUS_RANGES } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import { bucketOf, bucketStartsFor, overlapSeconds, rollUpBuckets, rollUpWindow } from "./rollup"

const day = new Date(Date.UTC(2026, 8, 6, 0, 0, 0))
const dayEnd = new Date(Date.UTC(2026, 8, 7))
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
			86_400,
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
		const totals = rollUpWindow(
			[
				{ state: "up", startedAt: at(0), endedAt: at(20) },
				{ state: "down", startedAt: at(20), endedAt: at(22) },
				{ state: "suspect", startedAt: at(22), endedAt: at(23) },
				{ state: "excluded", startedAt: at(23), endedAt: dayEnd },
			],
			day,
			dayEnd,
		)

		expect(totals.goodSeconds).toBe(20 * 3_600)
		expect(totals.badSeconds).toBe(2 * 3_600)
		expect(totals.unknownSeconds).toBe(3_600)
		expect(totals.excludedSeconds).toBe(3_600)
	})

	it("returns an empty day when nothing was recorded, rather than inventing good time", () => {
		expect(rollUpWindow([], day, dayEnd)).toEqual({
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

		expect(
			rollUpWindow([{ state: "up", startedAt: other, endedAt: otherEnd }], day, dayEnd).goodSeconds,
		).toBe(0)
	})
})

describe("cutting a range into bars", () => {
	const now = new Date("2026-09-13T10:07:30Z")

	const instants = [now, new Date("2026-09-13T08:00:00Z")]

	it("gives every range about ninety bars, not one per hour or per day", () => {
		expect(bucketStartsFor("24h", now)).toHaveLength(96)
		expect(bucketStartsFor("7d", now)).toHaveLength(84)
		expect(bucketStartsFor("30d", now)).toHaveLength(90)
	})

	it("starts the first bar exactly at the start of the range and every later one on a clock boundary, the last holding now", () => {
		for (const instant of instants) {
			for (const range of STATUS_RANGES) {
				const step = BUCKET_SECONDS[range] * 1000
				const starts = bucketStartsFor(range, instant).map((start) => start.getTime())
				const first = starts[0] ?? 0
				const later = starts.slice(1)
				const gaps = later.slice(1).map((start, index) => start - (later[index] ?? 0))
				const last = starts.at(-1) ?? 0

				expect(first).toBe(instant.getTime() - RANGE_SECONDS[range] * 1000)
				expect((later[0] ?? 0) - first).toBeGreaterThan(step)
				expect((later[0] ?? 0) - first).toBeLessThanOrEqual(2 * step)
				expect(later.filter((start) => start % step !== 0)).toEqual([])
				expect(gaps.filter((gap) => gap !== step)).toEqual([])
				expect(last).toBeLessThanOrEqual(instant.getTime())
				expect(instant.getTime()).toBeLessThan(last + step)
			}
		}
	})

	it("★ keeps every bar edge still across two refreshes a minute apart", () => {
		for (const range of STATUS_RANGES) {
			const edgesAt = (refreshedAt: Date) =>
				bucketStartsFor(range, refreshedAt)
					.slice(1)
					.map((start) => start.getTime())

			expect(edgesAt(new Date("2026-09-13T10:08:30Z"))).toEqual(edgesAt(now))
		}
	})

	it("counts every second of the range exactly once", () => {
		for (const instant of instants) {
			for (const range of STATUS_RANGES) {
				const buckets = rollUpBuckets(
					[{ state: "up", startedAt: new Date("2026-01-01T00:00:00Z"), endedAt: instant }],
					bucketStartsFor(range, instant),
					BUCKET_SECONDS[range],
				)
				const counted = buckets.reduce(
					(total, bucket) => total + bucket.availability.goodSeconds,
					0,
				)

				expect(counted).toBe(RANGE_SECONDS[range])
			}
		}
	})

	it("★ keeps an outage in the leading partial stretch of the range, inside the first bar", () => {
		for (const instant of instants) {
			for (const range of STATUS_RANGES) {
				const since = instant.getTime() - RANGE_SECONDS[range] * 1000
				const buckets = rollUpBuckets(
					[{ state: "down", startedAt: new Date(since), endedAt: new Date(since + 300_000) }],
					bucketStartsFor(range, instant),
					BUCKET_SECONDS[range],
				)

				expect(buckets.map((bucket) => bucket.availability.badSeconds)).toEqual([
					300,
					...Array.from({ length: buckets.length - 1 }, () => 0),
				])
			}
		}
	})
})

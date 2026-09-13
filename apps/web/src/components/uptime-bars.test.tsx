import { EMPTY_AVAILABILITY } from "@open-mcc/contracts"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { UptimeBars, verdictFor } from "./uptime-bars"

afterEach(cleanup)

const day = (patch: Partial<typeof EMPTY_AVAILABILITY>) => ({
	start: "2026-09-06T00:00:00.000Z",
	availability: { ...EMPTY_AVAILABILITY, ...patch },
})

describe("what colour a day gets", () => {
	it("shows a day with no measurements as blank, not as good", () => {
		expect(verdictFor(day({}))).toBe("none")
		expect(verdictFor(day({ unknownSeconds: 86_400 }))).toBe("none")
	})

	it("shows a fully reachable day as good", () => {
		expect(verdictFor(day({ goodSeconds: 86_400 }))).toBe("good")
	})

	it("shows a day with a short outage as partial rather than hiding it", () => {
		expect(verdictFor(day({ goodSeconds: 86_000, badSeconds: 400 }))).toBe("partial")
	})

	it("shows a badly broken day as bad", () => {
		expect(verdictFor(day({ goodSeconds: 40_000, badSeconds: 46_400 }))).toBe("bad")
	})

	it("does not let excluded time turn an unmeasured day green", () => {
		expect(verdictFor(day({ excludedSeconds: 86_400 }))).toBe("none")
	})
})

const QUARTER_HOUR = 15 * 60

const quarter = (index: number, patch: Partial<typeof EMPTY_AVAILABILITY>) => ({
	start: new Date(Date.UTC(2026, 8, 12, 10, 15) + index * QUARTER_HOUR * 1000).toISOString(),
	availability: { ...EMPTY_AVAILABILITY, ...patch },
})

const wholeDay = Array.from({ length: 96 }, (_, index) =>
	quarter(index, { goodSeconds: QUARTER_HOUR }),
)

describe("drawing a range as slim bars", () => {
	it("draws one bar for every bucket it is given", () => {
		render(<UptimeBars buckets={wholeDay} bucketSeconds={QUARTER_HOUR} fromLabel="24 hours ago" />)

		expect(screen.getAllByTitle(/^Reachable\s/)).toHaveLength(96)
	})

	it("lets the row share out the width rather than sizing a bar from the count", () => {
		render(<UptimeBars buckets={wholeDay} bucketSeconds={QUARTER_HOUR} fromLabel="24 hours ago" />)

		const sized = screen.getAllByTitle(/^Reachable\s/).filter((bar) => bar.hasAttribute("style"))
		expect(sized).toEqual([])
	})

	it("tells a brief outage apart from a long one and from no measurements on hover", () => {
		render(
			<UptimeBars
				buckets={[
					quarter(0, { goodSeconds: 895, badSeconds: 5 }),
					quarter(1, { goodSeconds: 400, badSeconds: 500 }),
					quarter(2, {}),
				]}
				bucketSeconds={QUARTER_HOUR}
				fromLabel="24 hours ago"
			/>,
		)

		expect(screen.getByTitle(/^Mostly reachable · 99\.4%\s/)).toBeTruthy()
		expect(screen.getByTitle(/^Not reachable · 44\.4%\s/)).toBeTruthy()
		expect(screen.getByTitle(/^No measurements\s/)).toBeTruthy()
	})

	it("names the time of day a bar starts and ends, not only its date", () => {
		render(
			<UptimeBars
				buckets={[quarter(0, { goodSeconds: QUARTER_HOUR })]}
				bucketSeconds={QUARTER_HOUR}
				fromLabel="24 hours ago"
			/>,
		)

		expect(screen.getByTitle(/^Reachable\s/).getAttribute("title")).toMatch(
			/\d:\d{2}\D+\d{1,2}:\d{2}/,
		)
	})
})

import { EMPTY_AVAILABILITY } from "@open-mcc/contracts"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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

const TWO_HOURS = 2 * 60 * 60

const bars = (count: number, seconds: number, patch: Partial<typeof EMPTY_AVAILABILITY>) =>
	Array.from({ length: count }, (_, index) => ({
		start: new Date(Date.UTC(2026, 8, 12, 10, 15) + index * seconds * 1000).toISOString(),
		availability: { ...EMPTY_AVAILABILITY, ...patch },
	}))

const quarter = (index: number, patch: Partial<typeof EMPTY_AVAILABILITY>) => ({
	start: new Date(Date.UTC(2026, 8, 12, 10, 15) + index * QUARTER_HOUR * 1000).toISOString(),
	availability: { ...EMPTY_AVAILABILITY, ...patch },
})

const wholeDay = bars(96, QUARTER_HOUR, { goodSeconds: QUARTER_HOUR })

const popupText = (): string => {
	const popup = document.querySelector(".text-popover-foreground")
	if (!popup) throw new Error("no tooltip popup is open")
	return popup.textContent ?? ""
}

describe("drawing a range as slim bars", () => {
	it("draws one bar for every bucket it is given", () => {
		render(<UptimeBars buckets={wholeDay} bucketSeconds={QUARTER_HOUR} />)

		expect(screen.getAllByLabelText(/^Reachable,/)).toHaveLength(96)
	})

	it("says how far back the row starts from the bars that came back, not the range asked for", () => {
		render(
			<UptimeBars
				buckets={bars(84, TWO_HOURS, { goodSeconds: TWO_HOURS })}
				bucketSeconds={TWO_HOURS}
			/>,
		)
		expect(screen.getByText("7 days ago")).toBeTruthy()
		cleanup()

		render(<UptimeBars buckets={wholeDay} bucketSeconds={QUARTER_HOUR} />)
		expect(screen.getByText("24 hours ago")).toBeTruthy()
	})

	it("tells a brief outage apart from a long one and from no measurements by its accessible name", () => {
		render(
			<UptimeBars
				buckets={[
					quarter(0, { goodSeconds: 895, badSeconds: 5 }),
					quarter(1, { goodSeconds: 400, badSeconds: 500 }),
					quarter(2, {}),
				]}
				bucketSeconds={QUARTER_HOUR}
			/>,
		)

		expect(screen.getByLabelText(/^Mostly reachable · 99\.44%,/)).toBeTruthy()
		expect(screen.getByLabelText(/^Not reachable · 44\.44%,/)).toBeTruthy()
		expect(screen.getByLabelText(/^No measurements,/)).toBeTruthy()
	})

	it("names the time of day a bar starts and ends, not only its date", () => {
		render(
			<UptimeBars
				buckets={[quarter(0, { goodSeconds: QUARTER_HOUR })]}
				bucketSeconds={QUARTER_HOUR}
			/>,
		)

		expect(screen.getByLabelText(/^Reachable,/).getAttribute("aria-label")).toMatch(
			/\d:\d{2}\D+\d{1,2}:\d{2}/,
		)
	})

	it("carries no native title on any bar", () => {
		const { container } = render(<UptimeBars buckets={wholeDay} bucketSeconds={QUARTER_HOUR} />)

		expect(container.querySelectorAll("[title]")).toHaveLength(0)
	})

	it("shows the verdict, percent and time span in the tooltip when a bar is focused", async () => {
		render(
			<UptimeBars
				buckets={[quarter(0, { goodSeconds: 895, badSeconds: 5 })]}
				bucketSeconds={QUARTER_HOUR}
			/>,
		)

		fireEvent.focus(screen.getByLabelText(/^Mostly reachable/))

		await waitFor(() => {
			expect(popupText()).toMatch(/^Mostly reachable · 99\.44%.*\d:\d{2}\D+\d{1,2}:\d{2}/)
		})
	})

	it("shows the same tooltip content on hover, not a native title", async () => {
		render(
			<UptimeBars
				buckets={[quarter(0, { goodSeconds: QUARTER_HOUR })]}
				bucketSeconds={QUARTER_HOUR}
			/>,
		)

		const bar = screen.getByLabelText(/^Reachable,/)
		fireEvent.mouseEnter(bar)
		fireEvent.mouseMove(bar)

		await waitFor(
			() => {
				expect(popupText()).toMatch(/^Reachable.*\d:\d{2}\D+\d{1,2}:\d{2}/)
			},
			{ timeout: 2000 },
		)
	})
})

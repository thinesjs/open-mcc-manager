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
	const popups = document.querySelectorAll('[data-slot="tooltip-popup"]')
	const popup = popups[popups.length - 1]
	if (!popup) throw new Error("no tooltip popup is open")
	return popup.textContent ?? ""
}

const threeBars = [
	quarter(0, { goodSeconds: QUARTER_HOUR }),
	quarter(1, { goodSeconds: 895, badSeconds: 5 }),
	quarter(2, {}),
]

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

describe("naming the row for assistive technology", () => {
	it("names the group after the subject when one is given", () => {
		const { container } = render(
			<UptimeBars buckets={wholeDay} bucketSeconds={QUARTER_HOUR} subject="host-1" />,
		)

		expect(container.querySelector('[role="toolbar"]')?.getAttribute("aria-label")).toBe(
			"host-1 uptime",
		)
	})

	it("falls back to a plain name without a subject", () => {
		const { container } = render(<UptimeBars buckets={wholeDay} bucketSeconds={QUARTER_HOUR} />)

		expect(container.querySelector('[role="toolbar"]')?.getAttribute("aria-label")).toBe("Uptime")
	})
})

describe("a roving tab stop across the row, not one per bar", () => {
	it("keeps exactly one bar in the tab order, on the newest bar by default", () => {
		const { container } = render(<UptimeBars buckets={wholeDay} bucketSeconds={QUARTER_HOUR} />)
		const buttons = container.querySelectorAll("button")
		const last = buttons[buttons.length - 1]
		const first = buttons[0]

		expect(container.querySelectorAll('button[tabindex="0"]')).toHaveLength(1)
		expect(last?.getAttribute("tabindex")).toBe("0")
		expect(first?.getAttribute("tabindex")).toBe("-1")
	})

	it("moves focus, and the shown tooltip, to the neighbouring bar with the arrow keys", async () => {
		render(<UptimeBars buckets={threeBars} bucketSeconds={QUARTER_HOUR} />)

		const first = screen.getByLabelText(/^Reachable,/)
		fireEvent.focus(first)
		fireEvent.keyDown(first, { key: "ArrowRight" })

		const second = screen.getByLabelText(/^Mostly reachable/)
		expect(document.activeElement).toBe(second)
		await waitFor(() => {
			expect(popupText()).toMatch(/^Mostly reachable/)
		})

		fireEvent.keyDown(second, { key: "ArrowLeft" })
		expect(document.activeElement).toBe(first)
		await waitFor(() => {
			expect(popupText()).toMatch(/^Reachable/)
		})
	})

	it("jumps to the first and last bar with Home and End", () => {
		render(<UptimeBars buckets={threeBars} bucketSeconds={QUARTER_HOUR} />)

		const middle = screen.getByLabelText(/^Mostly reachable/)
		fireEvent.focus(middle)

		fireEvent.keyDown(middle, { key: "End" })
		const last = screen.getByLabelText(/^No measurements/)
		expect(document.activeElement).toBe(last)

		fireEvent.keyDown(last, { key: "Home" })
		const first = screen.getByLabelText(/^Reachable,/)
		expect(document.activeElement).toBe(first)
	})

	it("fails if every bar becomes tabbable again", () => {
		const { container } = render(<UptimeBars buckets={wholeDay} bucketSeconds={QUARTER_HOUR} />)

		const tabbable = [...container.querySelectorAll("button")].filter(
			(button) => button.getAttribute("tabindex") !== "-1",
		)
		expect(tabbable).toHaveLength(1)
	})
})

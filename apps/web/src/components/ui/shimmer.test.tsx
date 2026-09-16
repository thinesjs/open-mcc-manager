import { QueryClient, QueryClientProvider, useSuspenseQuery } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FADE_SECONDS, fadeTransition, PageBoundary, PageShimmer } from "./shimmer"

const preference = vi.hoisted(() => ({ reduced: false }))

vi.mock("motion/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("motion/react")>()),
	useReducedMotion: () => preference.reduced,
}))

afterEach(() => {
	cleanup()
	preference.reduced = false
})

const CELL = ["col-start-1", "row-start-1"]

type Gate = {
	settle: (answer: string) => void
	fail: (reason: Error) => void
	answer: () => Promise<string>
}

const gate = (): Gate => {
	let settle: (answer: string) => void = () => undefined
	let fail: (reason: Error) => void = () => undefined
	const pending = new Promise<string>((resolve, reject) => {
		settle = resolve
		fail = reject
	})
	return { settle, fail, answer: () => pending }
}

const Surface = ({ answer }: { answer: () => Promise<string> }) => {
	const query = useSuspenseQuery({ queryKey: ["surface"], queryFn: answer, retry: false })
	return <p>{query.data}</p>
}

const mount = (answer: () => Promise<string>, seed?: string) => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	if (seed !== undefined) client.setQueryData(["surface"], seed)
	return render(
		<QueryClientProvider client={client}>
			<PageBoundary resetKey="/surface">
				<Surface answer={answer} />
			</PageBoundary>
		</QueryClientProvider>,
	)
}

const Ranged = ({ answers }: { answers: Map<string, () => Promise<string>> }) => {
	const [range, setRange] = useState("24h")
	return (
		<>
			<button type="button" onClick={() => setRange("7d")}>
				7 days
			</button>
			<RangedReading range={range} answers={answers} />
		</>
	)
}

const RangedReading = ({
	range,
	answers,
}: {
	range: string
	answers: Map<string, () => Promise<string>>
}) => {
	const query = useSuspenseQuery({
		queryKey: ["ranged", range],
		queryFn: answers.get(range) ?? (() => Promise.resolve("missing")),
		retry: false,
	})
	return <p>{query.data}</p>
}

const barsIn = (container: HTMLElement): NodeListOf<Element> =>
	container.querySelectorAll('[data-slot="shimmer-bar"]')

const wrapperIn = (container: HTMLElement): Element => {
	const found = container.querySelector("[aria-busy]")
	if (found === null) throw new Error("expected a wrapper carrying aria-busy")
	return found
}

const contentIn = (container: HTMLElement): Element => {
	const found = container.querySelector('[data-slot="page-content"]')
	if (found === null) throw new Error("expected a content region")
	return found
}

const classesOf = (element: Element): string[] => element.className.split(" ")

describe("a page while its data is still arriving", () => {
	it("shows the shimmer, then the content once the query resolves", async () => {
		const query = gate()
		const { container } = mount(query.answer)

		expect(barsIn(container).length).toBeGreaterThan(0)
		expect(screen.queryByText("arrived")).toBeNull()
		expect(wrapperIn(container).getAttribute("aria-busy")).toBe("true")

		query.settle("arrived")

		expect(await screen.findByText("arrived")).toBeDefined()
		await waitFor(() => {
			expect(wrapperIn(container).getAttribute("aria-busy")).toBe("false")
		})
		await waitFor(() => {
			expect(barsIn(container).length).toBe(0)
		})
	})

	it("says it is busy without reading the shimmer out, since the shimmer is decoration", () => {
		const query = gate()
		const { container } = mount(query.answer)

		expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
		expect(barsIn(container).length).toBeGreaterThan(0)
		expect(screen.getByRole("status").textContent).toBe("Loading")
	})

	it("keeps the live region mounted and empties it, so settling is announced too", async () => {
		const query = gate()
		mount(query.answer)

		query.settle("arrived")
		await screen.findByText("arrived")

		await waitFor(() => {
			expect(screen.getByRole("status").textContent).toBe("")
		})
	})

	it("never flashes the shimmer when the data was already in the cache", () => {
		const query = gate()
		const { container } = mount(query.answer, "arrived")

		expect(barsIn(container).length).toBe(0)
		expect(screen.getByText("arrived")).toBeDefined()
	})
})

describe("a settled page whose data changes under it", () => {
	it("shimmers again rather than blanking when the same route re-suspends", async () => {
		const first = gate()
		const second = gate()
		const answers = new Map([
			["24h", first.answer],
			["7d", second.answer],
		])
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const { container } = render(
			<QueryClientProvider client={client}>
				<PageBoundary resetKey="/ranged">
					<Ranged answers={answers} />
				</PageBoundary>
			</QueryClientProvider>,
		)

		first.settle("a day of readings")
		await screen.findByText("a day of readings")
		await waitFor(() => expect(barsIn(container).length).toBe(0))

		fireEvent.click(screen.getByText("7 days"))

		await waitFor(() => {
			expect(barsIn(container).length).toBeGreaterThan(0)
		})
		expect(wrapperIn(container).getAttribute("aria-busy")).toBe("true")

		second.settle("a week of readings")
		expect(await screen.findByText("a week of readings")).toBeDefined()
		await waitFor(() => expect(barsIn(container).length).toBe(0))
	})
})

describe("the swap from shimmer to content", () => {
	it("puts both in the same grid cell, so nothing moves when they trade places", async () => {
		const query = gate()
		const { container } = mount(query.answer)

		expect(classesOf(wrapperIn(container))).toContain("grid")

		const shimmer = container.querySelector('[aria-hidden="true"]')
		if (shimmer === null) throw new Error("expected a shimmer region")
		for (const cell of CELL) expect(classesOf(shimmer)).toContain(cell)

		query.settle("arrived")
		await screen.findByText("arrived")

		for (const cell of CELL) expect(classesOf(contentIn(container))).toContain(cell)
	})

	it("drops the shimmer animation for anyone who asked for less motion", () => {
		const { container } = render(<PageShimmer />)

		for (const bar of barsIn(container)) {
			expect(classesOf(bar)).toContain("animate-shimmer")
			expect(classesOf(bar)).toContain("motion-reduce:animate-none")
		}
	})

	it("computes no fade at all from a reduced-motion preference", () => {
		expect(fadeTransition(true).duration).toBe(0)
		expect(fadeTransition(false).duration).toBe(FADE_SECONDS)
	})

	it("feeds the reader's own reduced-motion preference into the fade it plays", () => {
		preference.reduced = true
		const reduced = mount(gate().answer, "arrived")
		expect(contentIn(reduced.container).getAttribute("data-fade-seconds")).toBe("0")
		cleanup()

		preference.reduced = false
		const moving = mount(gate().answer, "arrived")
		expect(contentIn(moving.container).getAttribute("data-fade-seconds")).toBe(`${FADE_SECONDS}`)
	})
})

describe("a page whose data never arrives", () => {
	it("shows the error rather than a blank page or a shimmer that never ends", async () => {
		const query = gate()
		const { container } = mount(query.answer)

		query.fail(new Error("The host did not answer."))

		expect(await screen.findByText("The host did not answer.")).toBeDefined()
		await waitFor(() => {
			expect(barsIn(container).length).toBe(0)
		})
	})

	it("offers a retry that refetches, rather than stranding the reader on the error", async () => {
		let attempt = 0
		const answer = () => {
			attempt += 1
			return attempt === 1
				? Promise.reject(new Error("The host did not answer."))
				: Promise.resolve("arrived")
		}
		mount(answer)

		await screen.findByText("The host did not answer.")
		fireEvent.click(screen.getByRole("button", { name: "Try again" }))

		expect(await screen.findByText("arrived")).toBeDefined()
	})
})

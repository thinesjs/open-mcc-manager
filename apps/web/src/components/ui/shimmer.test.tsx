import { QueryClient, QueryClientProvider, useSuspenseQuery } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { FADE_SECONDS, fadeTransition, PageBoundary, PageShimmer } from "./shimmer"

afterEach(cleanup)

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

const barsIn = (container: HTMLElement): NodeListOf<Element> =>
	container.querySelectorAll('[data-slot="shimmer-bar"]')

const wrapperIn = (container: HTMLElement): Element => {
	const found = container.querySelector("[aria-busy]")
	if (found === null) throw new Error("expected a wrapper carrying aria-busy")
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

		const shimmer = container.querySelector('[aria-hidden="true"]')
		expect(shimmer).not.toBeNull()
		expect(barsIn(container).length).toBeGreaterThan(0)
		expect(screen.getByRole("status").textContent).toBe("Loading")
	})

	it("never flashes the shimmer when the data was already in the cache", () => {
		const query = gate()
		const { container } = mount(query.answer, "arrived")

		expect(barsIn(container).length).toBe(0)
		expect(screen.getByText("arrived")).toBeDefined()
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

		const content = container.querySelector('[data-slot="page-content"]')
		if (content === null) throw new Error("expected a content region")
		for (const cell of CELL) expect(classesOf(content)).toContain(cell)
	})

	it("drops the animation and the fade for anyone who asked for less motion", () => {
		const { container } = render(<PageShimmer />)

		for (const bar of barsIn(container)) {
			expect(classesOf(bar)).toContain("animate-shimmer")
			expect(classesOf(bar)).toContain("motion-reduce:animate-none")
		}

		expect(fadeTransition(true).duration).toBe(0)
		expect(fadeTransition(false).duration).toBe(FADE_SECONDS)
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
})

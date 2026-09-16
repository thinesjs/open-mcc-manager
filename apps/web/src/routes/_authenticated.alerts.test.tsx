import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { type ReactNode, Suspense } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Route } from "./_authenticated.alerts"

type FailureRow = {
	deliveryId: string
	destinationId: string
	destinationName: string
	title: string
	reason: string | null
	attempts: number
	settledAt: string | null
}

type FailuresPage = {
	items: FailureRow[]
	total: number
	offset: number
}

type QueryInput = { offset?: number; deliveryId?: string }

type MutationVariables = { deliveryId?: string }

const PAGE_SIZE = 20

let failureRows: FailureRow[] = []

let failuresOverride: FailuresPage | undefined

const failureRow = (index: number): FailureRow => ({
	deliveryId: `del-${index}`,
	destinationId: "dest-1",
	destinationName: "Ops webhook",
	title: `Alert ${index}`,
	reason: "Server refused with 404",
	attempts: 1,
	settledAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
})

const seedFailures = (count: number): void => {
	failureRows = Array.from({ length: count }, (_, index) => failureRow(index))
}

const failuresPage = (offset: number): FailuresPage =>
	failuresOverride ?? {
		items: failureRows.slice(offset, offset + PAGE_SIZE),
		total: failureRows.length,
		offset,
	}

const answer = async (name: string): Promise<object | null> => {
	if (name === "me") return { role: "owner" }
	if (name === "list") return []
	return {}
}

let failuresDelayMs = 0

const procedure = (router: string, name: string) => ({
	queryOptions: (input?: QueryInput) => ({
		queryKey: input === undefined ? [router, name] : [router, name, input],
		queryFn: async () => {
			if (router !== "notification" || name !== "failures") return answer(name)
			if (failuresDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, failuresDelayMs))
			}
			return failuresPage(input?.offset ?? 0)
		},
	}),
	queryKey: (input?: QueryInput) => (input === undefined ? [router, name] : [router, name, input]),
	mutationOptions: () => ({
		mutationFn: async (variables: MutationVariables) => {
			if (router === "notification" && name === "dismiss" && variables.deliveryId !== undefined) {
				failureRows = failureRows.filter((row) => row.deliveryId !== variables.deliveryId)
			}
			return answer(name)
		},
	}),
})

const trpc = new Proxy(
	{},
	{
		get: (_root, router) =>
			new Proxy({}, { get: (_router, name) => procedure(String(router), String(name)) }),
	},
)

vi.setConfig({ testTimeout: 20_000 })

vi.mock("~/lib/trpc", () => ({ useTRPC: () => trpc }))

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<object>()),
	createFileRoute: () => (options: object) => ({ options }),
	Link: ({ children }: { children?: ReactNode }) => <a href="/alerts">{children}</a>,
	useNavigate: () => () => undefined,
}))

beforeEach(() => {
	seedFailures(0)
	failuresOverride = undefined
	failuresDelayMs = 0
})

afterEach(cleanup)

const mount = async () => {
	const Page = Route.options.component
	if (Page === undefined) throw new Error("the alerts route renders no page")
	await Page.preload?.()
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	render(
		<QueryClientProvider client={client}>
			<Suspense fallback={null}>
				<Page />
			</Suspense>
		</QueryClientProvider>,
	)
	return client
}

const countBeside = (headingText: string): string | null | undefined => {
	const heading = screen.getByText(headingText)
	return heading.parentElement?.querySelector("span")?.textContent
}

describe("how many alerts did not arrive", () => {
	it("shows the total, not the length of the page, beside the heading", async () => {
		seedFailures(25)
		await mount()

		await screen.findByText("1–20 of 25")
		expect(countBeside("Alerts that did not arrive")).toBe("25")
	})

	it("hides the footer when everything fits on one page", async () => {
		seedFailures(5)
		await mount()

		await screen.findByText("Alerts that did not arrive")
		expect(screen.queryByText(/of 5/)).toBeNull()
		expect(screen.queryByRole("button", { name: "Previous" })).toBeNull()
		expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
	})

	it("hides the whole section when there are no failures at all", async () => {
		seedFailures(0)
		await mount()

		await screen.findByText("No destinations")
		expect(screen.queryByText("Alerts that did not arrive")).toBeNull()
	})

	it("still renders the heading and the total when the page itself comes back empty", async () => {
		failuresOverride = { items: [], total: 25, offset: 0 }
		await mount()

		await screen.findByText("Alerts that did not arrive")
		expect(countBeside("Alerts that did not arrive")).toBe("25")
	})
})

describe("paging through alerts that did not arrive", () => {
	it("disables Previous on the first page and moves forward on Next", async () => {
		seedFailures(25)
		await mount()

		await screen.findByText("1–20 of 25")
		expect(screen.getByRole("button", { name: "Previous" })).toHaveProperty("disabled", true)
		expect(screen.getByText("Alert 0")).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: "Next" }))

		await screen.findByText("21–25 of 25")
		expect(screen.queryByText("Alert 0")).toBeNull()
		expect(screen.getByText("Alert 20")).toBeDefined()
		expect(screen.getByRole("button", { name: "Previous" })).toHaveProperty("disabled", false)
		expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", true)
	})

	it("steps back a page when the last item on the last page is dismissed", async () => {
		seedFailures(21)
		await mount()

		await screen.findByText("1–20 of 21")
		fireEvent.click(screen.getByRole("button", { name: "Next" }))
		await screen.findByText("21–21 of 21")

		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))

		await waitFor(() => {
			expect(countBeside("Alerts that did not arrive")).toBe("20")
			expect(screen.queryByText(/of 21/)).toBeNull()
			expect(screen.queryByRole("button", { name: "Previous" })).toBeNull()
		})
		expect(screen.getByText("Alert 0")).toBeDefined()
	})

	it("recovers to a valid page, not an empty box, when the total drops out from under the offset", async () => {
		seedFailures(25)
		const client = await mount()

		await screen.findByText("1–20 of 25")
		fireEvent.click(screen.getByRole("button", { name: "Next" }))
		await screen.findByText("21–25 of 25")

		failureRows = failureRows.slice(0, 19)
		await act(() => client.refetchQueries())

		await waitFor(() => expect(countBeside("Alerts that did not arrive")).toBe("19"))
		expect(screen.getByText("Alert 0")).toBeDefined()
		expect(screen.queryByRole("button", { name: "Previous" })).toBeNull()
		expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
	})

	it("keeps the range and the rows in sync while the next page is still loading", async () => {
		seedFailures(45)
		await mount()

		await screen.findByText("1–20 of 45")
		fireEvent.click(screen.getByRole("button", { name: "Next" }))
		await screen.findByText("21–40 of 45")

		failuresDelayMs = 50
		fireEvent.click(screen.getByRole("button", { name: "Next" }))

		expect(screen.queryByText("41–60 of 45")).toBeNull()
		expect(screen.getByText("21–40 of 45")).toBeDefined()
		expect(screen.getByText("Alert 20")).toBeDefined()

		failuresDelayMs = 0
		await screen.findByText("41–45 of 45")
		expect(screen.getByText("Alert 40")).toBeDefined()
	})

	it("never settles on a nonsense range when the total drops more than a page behind the offset", async () => {
		seedFailures(45)
		const client = await mount()

		await screen.findByText("1–20 of 45")
		fireEvent.click(screen.getByRole("button", { name: "Next" }))
		await screen.findByText("21–40 of 45")
		fireEvent.click(screen.getByRole("button", { name: "Next" }))
		await screen.findByText("41–45 of 45")

		failureRows = failureRows.slice(0, 25)
		await act(() => client.refetchQueries())

		await waitFor(() => expect(screen.queryByText("41–40 of 25")).toBeNull())
		await screen.findByText("21–25 of 25")
		expect(screen.getByText("Alert 20")).toBeDefined()
		expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", true)
	})
})

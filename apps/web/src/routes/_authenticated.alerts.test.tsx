import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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
}

type QueryInput = { offset?: number; deliveryId?: string }

type MutationVariables = { deliveryId?: string }

const PAGE_SIZE = 20

let failureRows: FailureRow[] = []

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

const failuresPage = (offset: number): FailuresPage => ({
	items: failureRows.slice(offset, offset + PAGE_SIZE),
	total: failureRows.length,
})

const answer = async (name: string): Promise<object | null> => {
	if (name === "me") return { role: "owner" }
	if (name === "list") return []
	return {}
}

const procedure = (router: string, name: string) => ({
	queryOptions: (input?: QueryInput) => ({
		queryKey: input === undefined ? [router, name] : [router, name, input],
		queryFn: async () =>
			router === "notification" && name === "failures"
				? failuresPage(input?.offset ?? 0)
				: answer(name),
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

		await waitFor(() => expect(screen.queryByText(/of 21/)).toBeNull())
		expect(countBeside("Alerts that did not arrive")).toBe("20")
		expect(screen.queryByRole("button", { name: "Previous" })).toBeNull()
		expect(screen.getByText("Alert 0")).toBeDefined()
	})
})

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen } from "@testing-library/react"
import { type ReactNode, Suspense } from "react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { Route } from "./_authenticated.hosts.new"

class UnmeasuredResizeObserver {
	observe = () => undefined
	unobserve = () => undefined
	disconnect = () => undefined
}

beforeAll(() => {
	vi.stubGlobal("ResizeObserver", UnmeasuredResizeObserver)
})

afterAll(() => {
	vi.unstubAllGlobals()
})

let role = "owner"

const answer = async (procedure: string): Promise<object | null> => {
	if (procedure === "me") return { role }
	if (procedure === "list") return []
	return null
}

const procedure = (router: string, name: string) => ({
	queryOptions: (input?: object) => ({
		queryKey: [router, name, input ?? {}],
		queryFn: () => answer(name),
	}),
	queryKey: (input?: object) => [router, name, input ?? {}],
	mutationOptions: (options: object) => ({ ...options, mutationFn: () => answer(name) }),
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
	Link: ({ children }: { children?: ReactNode }) => <a href="/hosts">{children}</a>,
	useNavigate: () => () => undefined,
}))

afterEach(() => {
	cleanup()
	role = "owner"
})

const mount = async () => {
	const Page = Route.options.component
	if (Page === undefined) throw new Error("the enrol route renders no page")
	await Page.preload?.()
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	render(
		<QueryClientProvider client={client}>
			<Suspense fallback={null}>
				<Page />
			</Suspense>
		</QueryClientProvider>,
	)
}

describe("opening the enrolment page by its address", () => {
	it("gives an owner the wizard", async () => {
		await mount()

		expect(await screen.findByRole("button", { name: "Continue" })).toBeDefined()
		expect(screen.queryByText("Only an owner can add a server.")).toBeNull()
	})

	it("★ gives a viewer the reason instead, rather than a wizard they cannot finish", async () => {
		role = "viewer"
		await mount()

		expect(await screen.findByText("Only an owner can add a server.")).toBeDefined()
		expect(screen.queryByRole("button", { name: "Continue" })).toBeNull()
	})
})

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { type ReactNode, Suspense } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Route } from "./_authenticated.hosts.index"

const HOST = {
	username: "pi",
	hostname: "box.example.com",
	port: 22,
	osId: null,
	osName: null,
	teardownError: null,
}

const HOSTS = [
	{
		...HOST,
		id: "stale",
		name: "Stale",
		status: "ready",
		lastSeenAt: "2026-01-01T00:00:00.000Z",
		failedUnits: 0,
	},
	{
		...HOST,
		id: "fresh",
		name: "Fresh",
		status: "provisioning",
		lastSeenAt: null,
		failedUnits: null,
	},
]

const answer = async (procedure: string): Promise<object | null> =>
	procedure === "list" ? HOSTS : null

const procedure = (router: string, name: string) => ({
	queryOptions: (input?: object) => ({
		queryKey: [router, name, input ?? {}],
		queryFn: () => answer(name),
	}),
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

afterEach(cleanup)

const mount = async () => {
	const Page = Route.options.component
	if (Page === undefined) throw new Error("the hosts route renders no page")
	await Page.preload?.()
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	render(
		<QueryClientProvider client={client}>
			<Suspense fallback={null}>
				<Page />
			</Suspense>
		</QueryClientProvider>,
	)
	await screen.findByText("Stale", {}, { timeout: 10_000 })
}

const hostCard = (name: string) => {
	const card = screen.getByText(name).closest("a")
	if (card === null) throw new Error(`no entry for ${name}`)
	return within(card)
}

describe.each([
	{ view: "cards", choose: async () => undefined },
	{
		view: "list",
		choose: async () => {
			fireEvent.click(screen.getByRole("button", { name: "List view" }))
			await screen.findByText("Stale")
		},
	},
])("a host in the $view view", ({ choose }) => {
	it("shows a ready host that stopped answering as offline, never also as ready", async () => {
		await mount()
		await choose()

		expect(hostCard("Stale").getByText("Offline")).toBeDefined()
		expect(hostCard("Stale").queryByText("Ready")).toBeNull()
	})

	it("shows a host that is still being set up by that step alone", async () => {
		await mount()
		await choose()

		expect(hostCard("Fresh").getByText("Provisioning")).toBeDefined()
		expect(hostCard("Fresh").queryByText("Not yet reached")).toBeNull()
	})
})

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { type ReactNode, Suspense } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PageBoundary } from "~/components/ui/shimmer"
import { Route as audit } from "./_authenticated.audit"
import { Route as instancesIndex } from "./_authenticated.instances.index"
import { Route as status } from "./_authenticated.status"

const HOST = {
	id: "host-1",
	name: "tjsx100",
	username: "pi",
	hostname: "box.example.com",
	port: 22,
	status: "ready",
	osId: null,
	osName: null,
	teardownError: null,
	lastSeenAt: "2026-09-01T00:00:00.000Z",
	failedUnits: 0,
}

const held = { ranges: new Set<string>(), auditPage: false }

const summaryFor = (range: string) => ({
	answering: 1,
	total: 1,
	bucketSeconds: 3600,
	hosts: [],
	bots: [],
	range,
})

const answerFor = (router: string, name: string, input: Record<string, string>): object | null => {
	if (router === "host" && name === "list") return [HOST]
	if (router === "instance" && name === "list") return []
	if (router === "member" && name === "me") return { role: "owner" }
	if (router === "status" && name === "summary") {
		const range = input.range ?? "24h"
		if (held.ranges.has(range)) return new Promise(() => undefined)
		return summaryFor(range)
	}
	if (router === "audit" && name === "list") {
		if (held.auditPage) return new Promise(() => undefined)
		return { items: [], total: 0, offset: 0 }
	}
	if (name === "list") return []
	return null
}

const procedure = (router: string, name: string) => ({
	queryKey: (input?: object) => [router, name, input ?? {}],
	queryOptions: (input?: Record<string, string>) => ({
		queryKey: [router, name, input ?? {}],
		queryFn: () => answerFor(router, name, input ?? {}),
	}),
	mutationOptions: (options: object) => ({ ...options, mutationFn: () => null }),
})

const trpc = new Proxy(
	{},
	{
		get: (_root, router) =>
			new Proxy({}, { get: (_router, name) => procedure(String(router), String(name)) }),
	},
)

vi.mock("~/lib/trpc", () => ({ useTRPC: () => trpc }))

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<object>()),
	createFileRoute: () => (options: object) => ({ options }),
	Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
	useNavigate: () => () => undefined,
}))

vi.setConfig({ testTimeout: 20_000 })

beforeEach(() => {
	held.ranges.clear()
	held.auditPage = false
})

afterEach(cleanup)

const mount = async (
	route: typeof audit | typeof instancesIndex | typeof status,
	settled: string,
) => {
	const Page = route.options.component
	if (Page === undefined) throw new Error("the route renders no page")
	await Page.preload?.()
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	render(
		<QueryClientProvider client={client}>
			<Suspense fallback={null}>
				<Page />
			</Suspense>
		</QueryClientProvider>,
	)
	await screen.findByText(settled, {}, { timeout: 10_000 })
}

describe("the status page while a longer range is still loading", () => {
	const settledStatusPage = async () => {
		held.ranges.add("7d")
		const Page = status.options.component
		if (Page === undefined) throw new Error("the status route renders no page")
		await Page.preload?.()
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const { container } = render(
			<QueryClientProvider client={client}>
				<PageBoundary resetKey="/status">
					<Page />
				</PageBoundary>
			</QueryClientProvider>,
		)
		await screen.findByText("1 of 1 answering", {}, { timeout: 10_000 })
		await waitFor(() =>
			expect(container.querySelectorAll('[data-slot="shimmer-bar"]')).toHaveLength(0),
		)
		return container
	}

	it("keeps the readings it already has on screen rather than falling back", async () => {
		const container = await settledStatusPage()

		fireEvent.click(screen.getByText("7 days"))

		expect(container.querySelectorAll('[data-slot="shimmer-bar"]')).toHaveLength(0)
		expect(container.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("false")
		const content = container.querySelector('[data-slot="page-content"]')
		expect(content?.getAttribute("style") ?? "").not.toContain("display: none")
		expect(screen.getByText("1 of 1 answering")).toBeDefined()
	})

	it("shows on the range row itself that it is working", async () => {
		const container = await settledStatusPage()

		fireEvent.click(screen.getByText("7 days"))

		await waitFor(() => {
			const row = container.querySelector('[data-slot="status-range"]')
			expect(row?.getAttribute("aria-busy")).toBe("true")
		})
		expect(screen.getByRole("img", { name: "Loading status" })).toBeDefined()
	})
})

describe("the instances page with no instances yet", () => {
	it("offers to create one straight away when a ready host is already there", async () => {
		await mount(instancesIndex, "No instances")

		expect(screen.queryByText("Go to hosts")).toBeNull()
		expect(
			screen.getByText(
				"An instance is one Minecraft Console Client running on a host, signed in to one Minecraft account.",
			),
		).toBeDefined()
	})
})

describe("the audit log while its page of entries is still loading", () => {
	it("tells a screen reader what is loading rather than shimmering in silence", async () => {
		held.auditPage = true
		await mount(audit, "Audit log")

		expect(screen.getByRole("status").textContent).toBe("Loading audit log")
	})
})

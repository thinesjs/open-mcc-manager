import { AUDIT_PAGE_SIZE, type AuditPage, type Role } from "@open-mcc/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { type ReactNode, Suspense } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Route } from "./_authenticated.audit"

type Input = { offset: number }

type PageState = { role: Role; total: number; action: string }

const state: PageState = { role: "owner", total: 137, action: "instance.start" }
const asked: number[] = []

const pageAt = (offset: number): AuditPage => ({
	items: Array.from(
		{ length: Math.min(AUDIT_PAGE_SIZE, Math.max(0, state.total - offset)) },
		(_entry, index) => ({
			id: `evt-${offset + index}`,
			actorLabel: "owner@example.com",
			action: state.action,
			subjectType: "instance",
			subjectId: `inst-${offset + index}`,
			detail: { name: `bot-${offset + index}` },
			createdAt: "2026-09-06T12:00:00.000Z",
		}),
	),
	total: state.total,
})

const answer = (router: string, name: string, input: Input | undefined): object => {
	if (router === "audit" && name === "list") {
		const offset = input?.offset ?? 0
		asked.push(offset)
		return pageAt(offset)
	}
	return { role: state.role }
}

const procedure = (router: string, name: string) => ({
	queryOptions: (input?: Input) => ({
		queryKey: [router, name, input ?? {}],
		queryFn: async () => answer(router, name, input),
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
	Link: ({ children }: { children?: ReactNode }) => <a href="/audit">{children}</a>,
	useNavigate: () => () => undefined,
}))

beforeEach(() => {
	state.role = "owner"
	state.total = 137
	state.action = "instance.start"
	asked.length = 0
})

afterEach(cleanup)

const mount = async () => {
	const Page = Route.options.component
	if (Page === undefined) throw new Error("the audit route renders no page")
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

describe("what an owner sees at the top of the audit log", () => {
	it("shows how much there is in total, not just what fits on the page", async () => {
		await mount()

		await waitFor(() => expect(screen.getByText("137 actions recorded")).toBeDefined())
	})

	it("counts a single recorded action in the singular", async () => {
		state.total = 1
		await mount()

		await waitFor(() => expect(screen.getByText("1 action recorded")).toBeDefined())
	})
})

describe("how a recorded action is written out", () => {
	it("reads as a sentence rather than the raw action string", async () => {
		state.total = 1
		await mount()

		await waitFor(() =>
			expect(screen.getByText("owner@example.com started the instance bot-0.")).toBeDefined(),
		)
		expect(screen.queryByText("instance.start")).toBeNull()
	})

	it("still renders an action nobody has written copy for, rather than breaking the page", async () => {
		state.total = 1
		state.action = "host.teleport"
		await mount()

		await waitFor(() =>
			expect(screen.getByText("owner@example.com host teleport bot-0.")).toBeDefined(),
		)
	})
})

describe("walking back through the trail", () => {
	it("pages forward and back over the same set", async () => {
		await mount()

		await waitFor(() => expect(screen.getByText(/started the instance bot-0\./)).toBeDefined())

		fireEvent.click(screen.getByRole("button", { name: "Next" }))
		await waitFor(() => expect(screen.getByText(/started the instance bot-50\./)).toBeDefined())
		expect(screen.queryByText(/started the instance bot-0\./)).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Previous" }))
		await waitFor(() => expect(screen.getByText(/started the instance bot-0\./)).toBeDefined())
		expect(asked).toContain(AUDIT_PAGE_SIZE)
	})

	it("stops at both ends rather than asking for a page that is not there", async () => {
		await mount()

		await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeDefined())
		const previous = screen.getByRole("button", { name: "Previous" })
		expect(previous.hasAttribute("disabled")).toBe(true)

		fireEvent.click(screen.getByRole("button", { name: "Next" }))
		await waitFor(() => expect(screen.getByText(/bot-50\./)).toBeDefined())
		fireEvent.click(screen.getByRole("button", { name: "Next" }))
		await waitFor(() => expect(screen.getByText(/bot-100\./)).toBeDefined())

		expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true)
	})

	it("offers no pager at all when everything already fits on one page", async () => {
		state.total = 3
		await mount()

		await waitFor(() => expect(screen.getByText("3 actions recorded")).toBeDefined())
		expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
		expect(screen.queryByRole("button", { name: "Previous" })).toBeNull()
	})
})

describe("a role that may not read the trail", () => {
	it.each(["operator", "viewer"] as const)(
		"refuses %s and asks the server for nothing",
		async (role) => {
			state.role = role
			await mount()

			await waitFor(() =>
				expect(screen.getByText("Only owners can read the audit log.")).toBeDefined(),
			)
			expect(asked).toEqual([])
			expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
		},
	)
})

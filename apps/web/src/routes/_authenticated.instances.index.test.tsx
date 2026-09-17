import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { type ReactNode, Suspense } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Route } from "./_authenticated.instances.index"

const BOT = {
	id: "bot-1",
	hostId: "host-1",
	name: "Miner",
	accountType: "microsoft",
	minecraftAccount: "miner@example.com",
	minecraftUsername: "Miner",
	status: "stopped",
	lastExitCode: null,
	createdAt: "2026-09-01T00:00:00.000Z",
}

const HOST = { id: "host-1", name: "vps-1", status: "ready" }

const server: { role: string; refusal: string | undefined } = {
	role: "owner",
	refusal: undefined,
}

class Refused extends Error {
	readonly data: { errorCode: string; httpStatus: number }

	constructor(errorCode: string) {
		super(errorCode)
		this.data = { errorCode, httpStatus: 409 }
	}
}

const answer = (name: string): object | null => {
	if (name === "list") return null
	if (name === "me") return { role: server.role }
	return null
}

const procedure = (router: string, name: string) => ({
	queryOptions: (input?: object) => ({
		queryKey: [router, name, input ?? {}],
		queryFn: async () =>
			router === "instance" ? [BOT] : router === "host" ? [HOST] : answer(name),
	}),
	mutationOptions: (options: object) => ({
		...options,
		mutationFn: (input: object) => {
			if (server.refusal !== undefined) throw new Refused(server.refusal)
			return Promise.resolve(input)
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
	Link: ({ children }: { children?: ReactNode }) => <a href="/instances">{children}</a>,
	useNavigate: () => () => undefined,
}))

beforeEach(() => {
	server.role = "owner"
	server.refusal = "INSTANCE_AUTH_IN_PROGRESS"
})

afterEach(() => {
	cleanup()
})

const mount = async () => {
	const Page = Route.options.component
	if (Page === undefined) throw new Error("the instance list route renders no page")
	await Page.preload?.()
	render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
				})
			}
		>
			<Suspense fallback={null}>
				<Page />
			</Suspense>
		</QueryClientProvider>,
	)
	const [card] = await screen.findAllByText("Miner", {}, { timeout: 10_000 })
	if (card === undefined) throw new Error("the instance list rendered no bot")
	return card
}

const startFromTheContextMenu = async () => {
	fireEvent.contextMenu(await mount())
	fireEvent.click(await screen.findByRole("menuitem", { name: "Start" }))
}

describe("a bot started from the list's context menu and refused", () => {
	it("★ says on the list what holds the bot, rather than swallowing the refusal", async () => {
		await startFromTheContextMenu()

		const alert = await screen.findByRole("alert")
		expect(alert.textContent).toContain("A sign-in is holding this bot")
		expect(alert.textContent).toContain("15 minutes")
	})

	it("★ carries the same way out the instance page carries", async () => {
		await startFromTheContextMenu()
		const alert = await screen.findByRole("alert")

		expect(await screen.findByRole("button", { name: "Cancel sign-in" })).toBeDefined()
		expect(alert.textContent).not.toContain("Ask an owner")
	})

	it("★ sends an operator to someone who may cancel, with no button they may not press", async () => {
		server.role = "operator"
		await startFromTheContextMenu()
		const alert = await screen.findByRole("alert")

		await waitFor(() => expect(alert.textContent).toContain("Ask an owner to cancel the sign-in."))
		expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull()
	})
})

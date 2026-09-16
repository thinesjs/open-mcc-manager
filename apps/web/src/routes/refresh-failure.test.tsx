import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, screen } from "@testing-library/react"
import { type ReactNode, Suspense } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Route as alerts } from "./_authenticated.alerts"
import { Route as audit } from "./_authenticated.audit"
import { Route as hostsIndex } from "./_authenticated.hosts.index"
import { Route as instancesIndex } from "./_authenticated.instances.index"
import { Route as members } from "./_authenticated.members"
import { Route as overview } from "./_authenticated.overview"
import { Route as sshKeys } from "./_authenticated.ssh-keys"
import { Route as status } from "./_authenticated.status"

const REFUSAL = "The control plane did not answer."

const state: { failing: string | null } = { failing: null }

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

const INSTANCE = {
	id: "bot-1",
	hostId: "host-1",
	name: "Miner",
	accountType: "offline",
	minecraftAccount: "Miner",
	minecraftUsername: "Miner",
	status: "stopped",
	lastExitCode: null,
	createdAt: "2026-09-01T00:00:00.000Z",
}

const FIXTURES: Record<string, object | null> = {
	list: [],
	me: { role: "owner" },
	offer: null,
	invitations: [],
	failures: { items: [], total: 0, offset: 0 },
	testResult: null,
	summary: { answering: 1, total: 1, bucketSeconds: 3600, hosts: [], bots: [] },
}

const answerFor = (router: string, procedure: string): object | null => {
	if (router === "host" && procedure === "list") return [HOST]
	if (router === "instance" && procedure === "list") return [INSTANCE]
	if (router === "audit" && procedure === "list") return { items: [], total: 0, offset: 0 }
	if (router === "sshKey" && procedure === "list") return []
	if (router === "notification" && procedure === "list") return []
	if (router === "member" && procedure === "list") return []
	return FIXTURES[procedure] ?? null
}

const procedure = (router: string, name: string) => ({
	queryKey: (input?: object) => [router, name, input ?? {}],
	queryOptions: (input?: object) => ({
		queryKey: [router, name, input ?? {}],
		queryFn: () =>
			state.failing === `${router}.${name}`
				? Promise.reject(new Error(REFUSAL))
				: answerFor(router, name),
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
	state.failing = null
})

afterEach(cleanup)

const PAGES = [
	{ name: "hosts", route: hostsIndex, settled: "tjsx100", primary: "host.list" },
	{
		name: "instances",
		route: instancesIndex,
		settled: "Every Minecraft Console Client this organization supervises.",
		primary: "instance.list",
	},
	{ name: "ssh keys", route: sshKeys, settled: "No SSH keys", primary: "sshKey.list" },
	{ name: "alerts", route: alerts, settled: "No destinations", primary: "notification.list" },
	{ name: "status", route: status, settled: "1 of 1 answering", primary: "status.summary" },
	{ name: "overview", route: overview, settled: "Needs attention", primary: "instance.list" },
	{ name: "members", route: members, settled: "Members", primary: "member.me" },
	{ name: "audit", route: audit, settled: "Audit log", primary: "member.me" },
] as const

describe.each(PAGES)("$name after a background refresh fails", ({ route, settled, primary }) => {
	it("says the page is out of date rather than showing stale data in silence", async () => {
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

		state.failing = primary
		await act(async () => {
			await client.refetchQueries()
		})

		expect((await screen.findAllByText(REFUSAL, {}, { timeout: 10_000 })).length).toBeGreaterThan(0)
		expect(screen.getByText(settled)).toBeDefined()
	})
})

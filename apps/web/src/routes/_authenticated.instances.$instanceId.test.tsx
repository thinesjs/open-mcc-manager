import {
	instanceConfigInput,
	type UpdateInstanceConfigInput,
	updateInstanceConfigInput,
} from "@open-mcc/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { type ReactNode, Suspense } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Route } from "./_authenticated.instances.$instanceId"

const BOT = {
	id: "bot-1",
	hostId: "host-1",
	name: "Miner",
	accountType: "microsoft",
	minecraftAccount: "miner@example.com",
	minecraftUsername: "Miner",
	status: "running",
	lastExitCode: null,
	createdAt: "2026-09-01T00:00:00.000Z",
}

const STATS = {
	health: 20,
	foodLevel: 20,
	level: 3,
	totalExperience: 1395,
	gamemode: 0,
	currentSlot: 1,
	yaw: 0,
	pitch: 0,
	tps: 20,
}

const NEARBY = { totalTracked: 3, entities: [{ id: 7, label: "Zombie", distance: 4 }] }

const SIGN_IN_CODE = "WXYZ-1234"

const FULL_CONFIG = instanceConfigInput.parse({
	accountType: "offline",
	minecraftAccount: "OpenMccBot",
	serverAddress: "play.example.com:25565",
	autoRelogRetries: 3,
	autoRelogEnabled: true,
	autoRelogDelaySeconds: { min: 5, max: 20 },
	antiAfkEnabled: true,
	antiAfkIntervalSeconds: { min: 90, max: 300 },
	liveControlEnabled: true,
	entityDataEnabled: true,
})

const server = {
	instance: BOT,
	config: { config: { liveControlEnabled: true, entityDataEnabled: true }, version: 1 },
	readsFail: false,
}

const params = { instanceId: "bot-1" }

const issued: string[] = []

const saves: UpdateInstanceConfigInput[] = []

const heldSave: { release: ((result: { version: number }) => void) | undefined; hold: boolean } = {
	release: undefined,
	hold: false,
}

const live = (reading: object): object => {
	if (server.readsFail) throw new Error("The bot's live view is not available right now.")
	return reading
}

const answer = async (procedure: string): Promise<object | null> => {
	switch (procedure) {
		case "get":
			return server.instance
		case "getConfig":
			return server.config
		case "list":
			return []
		case "readLivePlayerStats":
			return live(STATS)
		case "readLiveEntities":
			return live(NEARBY)
		default:
			return null
	}
}

const outcome = async (procedure: string, input: object): Promise<object | null> => {
	issued.push(procedure)
	switch (procedure) {
		case "updateConfig": {
			saves.push(updateInstanceConfigInput.parse(input))
			if (!heldSave.hold) return { version: 4 }
			return await new Promise<{ version: number }>((resolve) => {
				heldSave.release = resolve
			})
		}
		case "authenticate":
			return {
				userCode: SIGN_IN_CODE,
				verificationUri: "https://www.microsoft.com/link",
				expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
			}
		case "cancelAuthentication":
			return { authenticated: false, status: "needs_auth" }
		case "completeAuthentication":
			server.instance = { ...BOT, status: "stopped" }
			return { authenticated: true, status: "stopped" }
		default:
			return null
	}
}

const procedure = (router: string, name: string) => ({
	queryOptions: (input?: object) => ({
		queryKey: [router, name, input ?? {}],
		queryFn: () => answer(name),
	}),
	mutationOptions: (options: object) => ({
		...options,
		mutationFn: (input: object) => outcome(name, input),
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

vi.mock("~/components/bot-reliability", () => ({ BotReliability: () => null }))

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<object>()),
	createFileRoute: () => (options: object) => ({
		options,
		useParams: () => params,
	}),
	Link: ({ children }: { children?: ReactNode }) => <a href="/instances">{children}</a>,
	useNavigate: () => () => undefined,
}))

beforeEach(() => {
	server.instance = BOT
	server.config = { config: { liveControlEnabled: true, entityDataEnabled: true }, version: 1 }
	server.readsFail = false
	issued.length = 0
	saves.length = 0
	params.instanceId = "bot-1"
	heldSave.release = undefined
	heldSave.hold = false
})

afterEach(cleanup)

const mount = async () => {
	const Page = Route.options.component
	if (Page === undefined) throw new Error("the instance route renders no page")
	await Page.preload?.()
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
	render(
		<QueryClientProvider client={client}>
			<Suspense fallback={null}>
				<Page />
			</Suspense>
		</QueryClientProvider>,
	)
	await screen.findByRole("tab", { name: "Overview" }, { timeout: 10_000 })
	return client
}

const openTab = async (name: string) => {
	fireEvent.click(await screen.findByRole("tab", { name }))
}

const page = () => {
	const Page = Route.options.component
	if (Page === undefined) throw new Error("the instance route renders no page")
	return <Page />
}

describe("a live reading once the bot is no longer live", () => {
	it("stops showing the last reading when the bot stops", async () => {
		const client = await mount()
		await openTab("Live")
		expect(await screen.findByText("1395")).toBeDefined()

		server.instance = { ...BOT, status: "stopped" }
		server.readsFail = true
		await act(() => client.refetchQueries())

		await waitFor(() => expect(screen.queryByText("1395")).toBeNull())
		expect(screen.getByText(/Not live/)).toBeDefined()
	})

	it("stops showing the last reading when a running bot stops answering", async () => {
		const client = await mount()
		await openTab("Live")
		expect(await screen.findByText("1395")).toBeDefined()

		server.readsFail = true
		await act(() => client.refetchQueries())

		await waitFor(() => expect(screen.queryByText("1395")).toBeNull())
	})

	it("takes a panel away once the setting that feeds it is switched off", async () => {
		const client = await mount()
		await openTab("Live")
		expect(await screen.findByText("Zombie")).toBeDefined()

		server.config = { config: { liveControlEnabled: true, entityDataEnabled: false }, version: 1 }
		await act(() => client.refetchQueries())

		await waitFor(() => expect(screen.queryByText("Zombie")).toBeNull())
	})
})

describe("a Microsoft sign-in code", () => {
	const requestCode = async () => {
		server.instance = { ...BOT, status: "needs_auth" }
		await mount()
		fireEvent.click(await screen.findByRole("button", { name: "Get a sign-in code" }))
		expect(await screen.findByText(SIGN_IN_CODE)).toBeDefined()
	}

	it("says how long the code stays valid", async () => {
		await requestCode()

		expect(screen.getByText(/Valid for 15 more minutes/)).toBeDefined()
	})

	it("is taken off the page once the sign-in is cancelled", async () => {
		await requestCode()

		await openTab("Danger zone")
		fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }))

		await waitFor(() => expect(screen.queryByText(SIGN_IN_CODE)).toBeNull())
		expect(screen.queryByRole("button", { name: "I finished signing in" })).toBeNull()
	})

	it("leaves the bot stopped once signed in, with the normal Start button", async () => {
		await requestCode()

		fireEvent.click(await screen.findByRole("button", { name: "I finished signing in" }))

		expect(await screen.findByText("Signed in. Start the bot when you're ready.")).toBeDefined()
		const start = await screen.findByRole("button", { name: "Start" })
		await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false))
		expect(issued).not.toContain("start")
	})
})

describe("a settings save still in flight when the operator moves to another bot", () => {
	it("★ never writes the finished bot's version into the bot now on screen", async () => {
		server.config = { config: FULL_CONFIG, version: 3 }
		heldSave.hold = true
		const Page = Route.options.component
		if (Page === undefined) throw new Error("the instance route renders no page")
		await Page.preload?.()
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		})
		const { rerender } = render(
			<QueryClientProvider client={client}>
				<Suspense fallback={null}>{page()}</Suspense>
			</QueryClientProvider>,
		)
		await screen.findByRole("tab", { name: "Overview" }, { timeout: 10_000 })
		await openTab("Settings")
		fireEvent.click(await screen.findByRole("button", { name: "Save settings" }))
		await waitFor(() => expect(saves).toHaveLength(1))

		params.instanceId = "bot-2"
		heldSave.hold = false
		client.setQueryData(["instance", "get", { instanceId: "bot-2" }], BOT)
		client.setQueryData(["instance", "getConfig", { instanceId: "bot-2" }], {
			config: FULL_CONFIG,
			version: 3,
		})
		rerender(
			<QueryClientProvider client={client}>
				<Suspense fallback={null}>{page()}</Suspense>
			</QueryClientProvider>,
		)
		const release = heldSave.release
		if (release === undefined) throw new Error("the first save was never held")
		await act(async () => {
			release({ version: 8 })
		})

		fireEvent.click(
			await screen.findByRole("button", { name: "Save settings" }, { timeout: 10_000 }),
		)
		await waitFor(() => expect(saves).toHaveLength(2))

		expect(saves.map((each) => each.instanceId)).toEqual(["bot-1", "bot-2"])
		expect(saves.map((each) => each.expectedVersion)).toEqual([3, 3])
	})
})

import {
	instanceConfigInput,
	instanceIdInput,
	instanceStatusSchema,
	type UpdateInstanceConfigInput,
	updateInstanceConfigInput,
} from "@open-mcc/contracts"
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { type ReactNode, Suspense } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	describeSignInWaitWindow,
	SIGN_IN_CHECK_INTERVAL_MS,
	SIGN_IN_WAIT_WINDOW_MS,
} from "~/lib/sign-in-wait"
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

const signIn: {
	recordAfter: number
	rejectFrom: number
	landsAs: "stopped" | "running"
	calls: number
	targets: string[]
	inFlight: number
	peak: number
	hold: boolean
	release: (() => void) | undefined
} = {
	recordAfter: 1,
	rejectFrom: Number.MAX_SAFE_INTEGER,
	landsAs: "stopped",
	calls: 0,
	targets: [],
	inFlight: 0,
	peak: 0,
	hold: false,
	release: undefined,
}

const live = (reading: object): object => {
	if (server.readsFail) throw new Error("The bot's live view is not available right now.")
	return reading
}

const asked: string[] = []

const refusal: { code: string | undefined } = { code: undefined }

class Refused extends Error {
	readonly data: { errorCode: string; httpStatus: number }

	constructor(errorCode: string) {
		super(errorCode)
		this.data = { errorCode, httpStatus: 409 }
	}
}

const answer = async (procedure: string): Promise<object | null> => {
	asked.push(procedure)
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
		case "start":
		case "stop":
		case "restart":
		case "remove":
			if (refusal.code !== undefined) throw new Refused(refusal.code)
			return null
		case "authenticate":
			return {
				userCode: SIGN_IN_CODE,
				verificationUri: "https://www.microsoft.com/link",
				expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
			}
		case "cancelAuthentication":
			return { authenticated: false, status: "needs_auth" }
		case "completeAuthentication": {
			signIn.calls += 1
			signIn.targets.push(instanceIdInput.parse(input).instanceId)
			signIn.inFlight += 1
			signIn.peak = Math.max(signIn.peak, signIn.inFlight)
			try {
				if (signIn.hold) {
					await new Promise<void>((resolve) => {
						signIn.release = resolve
					})
				}
				if (signIn.calls >= signIn.rejectFrom) {
					throw new Error("The bot's host could not be reached.")
				}
				if (signIn.calls < signIn.recordAfter) {
					return { authenticated: false, status: "needs_auth" }
				}
				server.instance = { ...BOT, status: signIn.landsAs }
				return { authenticated: true, status: signIn.landsAs }
			} finally {
				signIn.inFlight -= 1
			}
		}
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
	vi.useRealTimers()
	signIn.recordAfter = 1
	signIn.rejectFrom = Number.MAX_SAFE_INTEGER
	signIn.landsAs = "stopped"
	signIn.calls = 0
	signIn.targets.length = 0
	signIn.inFlight = 0
	signIn.peak = 0
	signIn.hold = false
	signIn.release = undefined
	server.instance = BOT
	server.config = { config: { liveControlEnabled: true, entityDataEnabled: true }, version: 1 }
	server.readsFail = false
	issued.length = 0
	asked.length = 0
	saves.length = 0
	params.instanceId = "bot-1"
	heldSave.release = undefined
	heldSave.hold = false
	refusal.code = undefined
})

afterEach(() => {
	vi.useRealTimers()
	focusManager.setFocused(undefined)
	cleanup()
})

const mount = async () => {
	const Page = Route.options.component
	if (Page === undefined) throw new Error("the instance route renders no page")
	await Page.preload?.()
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
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

const LIVE_READS = [
	"readLiveChat",
	"readLiveWorld",
	"readLiveEntities",
	"readLiveInventory",
	"readLivePlayerStats",
	"readLiveStatusEffects",
	"readLiveBots",
	"readLivePlayers",
	"readLiveEvents",
	"readLiveStatus",
] as const

const READS_ON_LIVE_CONTROL = [
	"readLiveChat",
	"readLivePlayerStats",
	"readLiveStatusEffects",
	"readLiveBots",
	"readLivePlayers",
	"readLiveEvents",
	"readLiveStatus",
] as const

const EVERY_LIVE_SETTING = {
	liveControlEnabled: true,
	worldDataEnabled: true,
	entityDataEnabled: true,
	inventoryDataEnabled: true,
}

const LIVE_CONTROL_ALONE = {
	liveControlEnabled: true,
	worldDataEnabled: false,
	entityDataEnabled: false,
	inventoryDataEnabled: false,
}

const NO_LIVE_SETTING = {
	liveControlEnabled: false,
	worldDataEnabled: false,
	entityDataEnabled: false,
	inventoryDataEnabled: false,
}

const NOT_RUNNING = instanceStatusSchema.options.filter((status) => status !== "running")

const LONGEST_LIVE_INTERVAL_MS = 5000

const CONSOLE_INTERVAL_MS = 3000

describe("polling a bot for a live reading", () => {
	const pollFor = async (
		status: typeof BOT.status,
		config: typeof EVERY_LIVE_SETTING,
	): Promise<void> => {
		server.instance = { ...BOT, status }
		server.config = { config, version: 1 }
		vi.useFakeTimers({ shouldAdvanceTime: true })
		await mount()
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LONGEST_LIVE_INTERVAL_MS * 3)
		})
	}

	const liveReads = () => LIVE_READS.filter((name) => asked.includes(name))

	it.each(NOT_RUNNING)(
		"★ never reaches a bot that is %s, however much live control is switched on",
		async (status) => {
			await pollFor(status, EVERY_LIVE_SETTING)

			expect(liveReads()).toEqual([])
		},
	)

	it("★ reads everything the settings ask for while the bot runs", async () => {
		await pollFor("running", EVERY_LIVE_SETTING)

		expect(liveReads()).toEqual([...LIVE_READS])
	})

	it("★ reads nothing from a running bot whose live settings are off", async () => {
		await pollFor("running", NO_LIVE_SETTING)

		expect(liveReads()).toEqual([])
	})

	it("★ leaves the world, entity and inventory reads to their own settings", async () => {
		await pollFor("running", LIVE_CONTROL_ALONE)

		expect(liveReads()).toEqual([...READS_ON_LIVE_CONTROL])
	})
})

describe("polling a bot for its console", () => {
	const pollFor = async (status: typeof BOT.status): Promise<number> => {
		server.instance = { ...BOT, status }
		server.config = { config: NO_LIVE_SETTING, version: 1 }
		vi.useFakeTimers({ shouldAdvanceTime: true })
		await mount()
		await act(async () => {
			await vi.advanceTimersByTimeAsync(CONSOLE_INTERVAL_MS * 3)
		})
		return asked.filter((each) => each === "readConsole").length
	}

	it("★ keeps reading a running bot's console", async () => {
		expect(await pollFor("running")).toBeGreaterThan(1)
	})

	it.each(NOT_RUNNING)("★ reads a bot that is %s once and then leaves it alone", async (status) => {
		expect(await pollFor(status)).toBe(1)
	})
})

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

describe("waiting for a sign-in to land after Microsoft says it is done", () => {
	const WAITING = /no need to press again/
	const GAVE_UP = new RegExp(`Still no sign-in after ${describeSignInWaitWindow()}`)

	const settle = async () => {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1)
		})
	}

	const advance = async (ms: number) => {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ms)
		})
	}

	const tree = (client: QueryClient) => (
		<QueryClientProvider client={client}>
			<Suspense fallback={null}>{page()}</Suspense>
		</QueryClientProvider>
	)

	const finish = () => screen.getByRole("button", { name: "I finished signing in" })

	const getCode = () => screen.getByRole("button", { name: "Get a sign-in code" })

	const startSignIn = async () => {
		server.instance = { ...BOT, status: "needs_auth" }
		server.config = { config: { liveControlEnabled: false, entityDataEnabled: false }, version: 1 }
		const Page = Route.options.component
		if (Page === undefined) throw new Error("the instance route renders no page")
		await Page.preload?.()
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		})
		const { rerender } = render(tree(client))
		await screen.findByRole("tab", { name: "Overview" }, { timeout: 10_000 })
		fireEvent.click(await screen.findByRole("button", { name: "Get a sign-in code" }))
		expect(await screen.findByText(SIGN_IN_CODE)).toBeDefined()
		vi.useFakeTimers()
		return { client, rerender }
	}

	const press = async () => {
		fireEvent.click(finish())
		await settle()
	}

	const release = async () => {
		signIn.hold = false
		const open = signIn.release
		if (open === undefined) throw new Error("no check was ever held in flight")
		signIn.release = undefined
		await act(async () => {
			open()
		})
		await settle()
	}

	it("★ keeps checking on its own until the sign-in lands, on a single press", async () => {
		signIn.recordAfter = 3
		await startSignIn()

		await press()
		expect(signIn.calls).toBe(1)
		expect(screen.getByText(WAITING)).toBeDefined()

		await advance(SIGN_IN_CHECK_INTERVAL_MS)
		expect(signIn.calls).toBe(2)
		expect(screen.getByText(WAITING)).toBeDefined()

		await advance(SIGN_IN_CHECK_INTERVAL_MS)

		expect(signIn.calls).toBe(3)
		expect(screen.getByText("Signed in. Start the bot when you're ready.")).toBeDefined()
		expect(screen.queryByText(WAITING)).toBeNull()
	})

	it("★ stops checking once the window passes and says what to do next", async () => {
		signIn.recordAfter = Number.MAX_SAFE_INTEGER
		await startSignIn()
		await press()

		await advance(SIGN_IN_WAIT_WINDOW_MS + SIGN_IN_CHECK_INTERVAL_MS)

		const cadence = SIGN_IN_WAIT_WINDOW_MS / SIGN_IN_CHECK_INTERVAL_MS
		expect(signIn.calls).toBeGreaterThanOrEqual(cadence - 1)
		expect(signIn.calls).toBeLessThanOrEqual(cadence + 2)
		expect(screen.getByText(GAVE_UP)).toBeDefined()
		expect(screen.queryByText(WAITING)).toBeNull()

		const stopped = signIn.calls
		await advance(SIGN_IN_WAIT_WINDOW_MS)

		expect(signIn.calls).toBe(stopped)
	})

	it("★ never lets two checks run at once", async () => {
		signIn.recordAfter = Number.MAX_SAFE_INTEGER
		await startSignIn()
		await press()

		signIn.hold = true
		await advance(SIGN_IN_CHECK_INTERVAL_MS)
		expect(signIn.inFlight).toBe(1)

		await advance(SIGN_IN_CHECK_INTERVAL_MS * 4)

		expect(signIn.calls).toBe(2)
		expect(signIn.peak).toBe(1)

		await release()

		expect(signIn.peak).toBe(1)
	})

	it("★ checks by hand without doubling the checks or moving the deadline", async () => {
		signIn.recordAfter = Number.MAX_SAFE_INTEGER
		await startSignIn()
		await press()

		await advance(SIGN_IN_WAIT_WINDOW_MS / 2)
		const automatic = signIn.calls

		fireEvent.click(finish())
		await settle()
		expect(signIn.calls).toBe(automatic + 1)

		await advance(SIGN_IN_CHECK_INTERVAL_MS)
		expect(signIn.calls).toBe(automatic + 2)
		expect(screen.getByText(WAITING)).toBeDefined()

		await advance(SIGN_IN_WAIT_WINDOW_MS / 2)

		expect(screen.getByText(GAVE_UP)).toBeDefined()
	})

	it("says nothing about waiting until a check has answered “not yet”", async () => {
		signIn.recordAfter = 1
		await startSignIn()

		expect(screen.queryByText(WAITING)).toBeNull()
		expect(screen.queryByText(GAVE_UP)).toBeNull()

		await press()

		expect(screen.queryByText(WAITING)).toBeNull()
		expect(screen.queryByText(GAVE_UP)).toBeNull()
		expect(screen.getByText("Signed in. Start the bot when you're ready.")).toBeDefined()
	})

	it("★ never carries a wait over to the bot the operator moves to", async () => {
		signIn.recordAfter = Number.MAX_SAFE_INTEGER
		const { client, rerender } = await startSignIn()
		await press()
		await advance(SIGN_IN_CHECK_INTERVAL_MS)
		const beforeSwitch = [...signIn.targets]

		params.instanceId = "bot-2"
		client.setQueryData(["instance", "get", { instanceId: "bot-2" }], {
			...BOT,
			id: "bot-2",
			status: "stopped",
		})
		client.setQueryData(["instance", "getConfig", { instanceId: "bot-2" }], {
			config: { liveControlEnabled: false, entityDataEnabled: false },
			version: 1,
		})
		await act(async () => {
			rerender(tree(client))
		})
		await advance(SIGN_IN_CHECK_INTERVAL_MS * 3)

		expect(beforeSwitch).toEqual(["bot-1", "bot-1"])
		expect(signIn.targets.slice(beforeSwitch.length)).toEqual([])
		expect(screen.queryByText(WAITING)).toBeNull()
		expect(screen.queryByText(GAVE_UP)).toBeNull()
	})

	it("★ leaves every control alive while it checks on its own, and only greys them out by hand", async () => {
		signIn.recordAfter = Number.MAX_SAFE_INTEGER
		await startSignIn()
		await press()

		signIn.hold = true
		await advance(SIGN_IN_CHECK_INTERVAL_MS)
		await settle()
		expect(signIn.inFlight).toBe(1)

		expect(getCode().hasAttribute("disabled")).toBe(false)
		expect(finish().hasAttribute("disabled")).toBe(false)

		await release()

		signIn.hold = true
		fireEvent.click(finish())
		await settle()
		expect(signIn.inFlight).toBe(1)

		expect(getCode().hasAttribute("disabled")).toBe(true)
		expect(screen.queryByRole("button", { name: "I finished signing in" })).toBeNull()

		await release()
	})

	it("★ ends the wait on the clock even when a check never comes back", async () => {
		signIn.recordAfter = Number.MAX_SAFE_INTEGER
		await startSignIn()
		await press()

		signIn.hold = true
		await advance(SIGN_IN_CHECK_INTERVAL_MS)
		expect(signIn.inFlight).toBe(1)

		await advance(SIGN_IN_WAIT_WINDOW_MS)

		expect(signIn.inFlight).toBe(1)
		expect(screen.queryByText(WAITING)).toBeNull()
		expect(screen.getByText(GAVE_UP)).toBeDefined()

		await release()
	})

	it("★ stops checking the moment one fails, and still says what to do", async () => {
		signIn.recordAfter = Number.MAX_SAFE_INTEGER
		signIn.rejectFrom = 2
		await startSignIn()
		await press()
		expect(screen.getByText(WAITING)).toBeDefined()

		await advance(SIGN_IN_CHECK_INTERVAL_MS)
		const afterFailure = signIn.calls
		expect(afterFailure).toBe(2)

		await advance(SIGN_IN_CHECK_INTERVAL_MS * 4)

		expect(signIn.calls).toBe(afterFailure)
		expect(screen.queryByText(WAITING)).toBeNull()
		expect(screen.getByText(GAVE_UP)).toBeDefined()
	})

	it("★ waits again when the operator presses after the window ended", async () => {
		signIn.recordAfter = Number.MAX_SAFE_INTEGER
		await startSignIn()
		await press()
		await advance(SIGN_IN_WAIT_WINDOW_MS + SIGN_IN_CHECK_INTERVAL_MS)
		expect(screen.getByText(GAVE_UP)).toBeDefined()
		const ended = signIn.calls

		await press()

		expect(signIn.calls).toBe(ended + 1)
		expect(screen.getByText(WAITING)).toBeDefined()
		expect(screen.queryByText(GAVE_UP)).toBeNull()

		await advance(SIGN_IN_CHECK_INTERVAL_MS)

		expect(signIn.calls).toBe(ended + 2)
	})

	it("does not tell the operator to start a bot that is already running", async () => {
		signIn.recordAfter = 1
		signIn.landsAs = "running"
		await startSignIn()

		await press()

		expect(screen.getByText("Signed in.")).toBeDefined()
		expect(screen.queryByText("Signed in. Start the bot when you're ready.")).toBeNull()
	})
})

describe("coming back to a tab that was left open", () => {
	const SUSPENSE_STALE_MS = 1_000

	const comeBack = async () => {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SUSPENSE_STALE_MS + 1)
		})
		asked.length = 0
		focusManager.setFocused(false)
		await act(async () => {
			focusManager.setFocused(true)
		})
	}

	it("★ reads the bot's own status again, and nothing that costs an SSH login", async () => {
		server.config = { config: EVERY_LIVE_SETTING, version: 1 }
		vi.useFakeTimers({ shouldAdvanceTime: true })
		await mount()
		await waitFor(() => {
			for (const read of LIVE_READS) expect(asked, read).toContain(read)
		})

		await comeBack()

		expect(asked).toEqual(["get"])
	})

	it("★ reads the whole schedule again, which another operator may have changed", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		await mount()
		await openTab("Schedule")
		await waitFor(() => {
			expect(asked).toContain("listScheduledCommands")
			expect(asked).toContain("getSleepWindow")
		})

		await comeBack()

		expect([...asked].sort()).toEqual(["get", "getSleepWindow", "listScheduledCommands"])
	})
})

describe("a lifecycle action refused while a sign-in still holds the bot", () => {
	const refuseStart = async (errorCode: string) => {
		server.instance = { ...BOT, status: "stopped" }
		refusal.code = errorCode
		await mount()
		fireEvent.click(await screen.findByRole("button", { name: "Start" }))
		return await screen.findByRole("alert")
	}

	it("★ says how long the hold lasts rather than that a sign-in is under way", async () => {
		const alert = await refuseStart("INSTANCE_AUTH_IN_PROGRESS")

		expect(alert.textContent).toContain("15 minutes")
		expect(alert.textContent).not.toMatch(/being signed in|wait for that to finish|is running/i)
	})

	it("★ offers the way out from the refusal itself, not only under the Danger zone", async () => {
		const alert = await refuseStart("INSTANCE_AUTH_IN_PROGRESS")

		fireEvent.click(within(alert).getByRole("button", { name: "Cancel sign-in" }))

		await waitFor(() => expect(issued).toContain("cancelAuthentication"))
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
	})

	it("★ offers no sign-in to cancel on a refusal no sign-in is holding", async () => {
		const alert = await refuseStart("INSTANCE_BUSY")

		expect(alert.textContent).toContain("busy with another change")
		expect(within(alert).queryByRole("button", { name: "Cancel sign-in" })).toBeNull()
	})
})

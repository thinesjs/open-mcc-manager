import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CommandPalette } from "./command-palette"
import { InstanceActionError } from "./instance-action-error"

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

const procedure = (router: string, name: string) => ({
	queryOptions: (input?: object) => ({
		queryKey: [router, name, input ?? {}],
		queryFn: async () =>
			router === "instance" ? [BOT] : router === "host" ? [] : { role: server.role },
	}),
	mutationOptions: (options: object) => ({
		...options,
		mutationFn: async (input: object) => {
			if (server.refusal !== undefined) throw new Refused(server.refusal)
			return input
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
	useNavigate: () => () => undefined,
}))

beforeEach(() => {
	server.role = "owner"
	server.refusal = "INSTANCE_AUTH_IN_PROGRESS"
})

afterEach(() => {
	cleanup()
})

const Harness = () => {
	const [refused, setRefused] = useState<
		{ instanceId: string; error: { message: string } } | undefined
	>(undefined)

	return (
		<>
			{refused ? (
				<InstanceActionError
					error={refused.error}
					instanceId={refused.instanceId}
					busy={false}
					onCancelled={() => setRefused(undefined)}
				/>
			) : null}
			<CommandPalette
				open
				instant
				onClose={() => undefined}
				onActionError={(instanceId, error) => setRefused({ instanceId, error })}
			/>
		</>
	)
}

const startFromThePalette = async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
	render(
		<QueryClientProvider client={client}>
			<Harness />
		</QueryClientProvider>,
	)
	fireEvent.change(await screen.findByLabelText("Search instances, hosts and actions"), {
		target: { value: "Start Miner" },
	})
	fireEvent.click(await screen.findByText("Start Miner", {}, { timeout: 10_000 }))
	return await screen.findByRole("alert")
}

describe("a bot started from the command palette and refused", () => {
	it("★ says what holds the bot instead of closing over the refusal in silence", async () => {
		const alert = await startFromThePalette()

		expect(alert.textContent).toContain("A sign-in is holding this bot")
		expect(alert.textContent).toContain("15 minutes")
	})

	it("★ carries the way out, for the bot the refusal names", async () => {
		await startFromThePalette()

		expect(await screen.findByRole("button", { name: "Cancel sign-in" })).toBeDefined()
	})

	it("★ sends an operator to someone who may cancel", async () => {
		server.role = "operator"
		const alert = await startFromThePalette()

		await waitFor(() => expect(alert.textContent).toContain("Ask an owner to cancel the sign-in."))
		expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull()
	})
})

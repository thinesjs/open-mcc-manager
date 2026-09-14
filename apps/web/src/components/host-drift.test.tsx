import type { HostReconciliation } from "@open-mcc/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HostDrift } from "./host-drift"

const restart = vi.fn()

const INSTANCES = [
	{ id: "parked", name: "Parked", status: "stopped" },
	{ id: "busy", name: "Busy", status: "running" },
]

const RECONCILIATION: HostReconciliation = {
	hostId: "host-1",
	reachable: true,
	unitDrift: [],
	stateDrift: [],
	configDrift: ["parked", "busy"].map((instanceId) => ({
		instanceId,
		kind: "managed",
		key: "Main.General.Server",
		expected: "play.example.com",
		actual: "old.example.com",
	})),
}

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: ReactNode }) => <a href="/instances">{children}</a>,
}))

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		instance: {
			restart: {
				mutationOptions: (options: object) => ({ ...options, mutationFn: restart }),
			},
			list: {
				queryOptions: () => ({ queryKey: ["instance", "list"], queryFn: () => INSTANCES }),
			},
			reconcileHost: {
				queryOptions: () => ({
					queryKey: ["instance", "reconcile"],
					queryFn: () => RECONCILIATION,
				}),
			},
		},
	}),
}))

afterEach(() => {
	cleanup()
	restart.mockReset()
})

const mount = () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	render(
		<QueryClientProvider client={client}>
			<HostDrift hostId="host-1" ready={true} />
		</QueryClientProvider>,
	)
}

const rowFor = async (name: string) => {
	const link = await screen.findByText(name)
	const row = link.closest("li")
	if (row === null) throw new Error(`no drift row for ${name}`)
	return within(row)
}

describe("fixing a bot whose config drifted", () => {
	it("never offers a restart for a bot the operator stopped, because that would start it", async () => {
		mount()
		const parked = await rowFor("Parked")

		expect(parked.queryByRole("button", { name: "Restart to fix" })).toBeNull()
		expect(parked.getByText("Fixed the next time it starts.")).toBeDefined()
	})

	it("restarts a running bot, and only that bot", async () => {
		mount()
		const busy = await rowFor("Busy")

		fireEvent.click(busy.getByRole("button", { name: "Restart to fix" }))

		await waitFor(() => expect(restart).toHaveBeenCalledTimes(1))
		expect(restart.mock.calls[0]?.[0]).toEqual({ instanceId: "busy" })
	})
})

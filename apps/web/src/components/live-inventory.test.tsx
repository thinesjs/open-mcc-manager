import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getErrorMessage } from "~/lib/errors"
import { LiveInventory } from "./live-inventory"

const drop = vi.fn()
const hold = vi.fn()

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		instance: {
			dropInventoryItem: {
				mutationOptions: (options: object) => ({ ...options, mutationFn: drop }),
			},
			selectHeldItem: {
				mutationOptions: (options: object) => ({ ...options, mutationFn: hold }),
			},
		},
	}),
}))

afterEach(() => {
	cleanup()
	drop.mockReset()
	hold.mockReset()
})

const refused = Object.assign(new Error("refused"), {
	data: { errorCode: "INSTANCE_LIVE_CONTROL_UNREADABLE" },
})

const shown = getErrorMessage(refused)

const mount = () => {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	render(
		<QueryClientProvider client={client}>
			<LiveInventory
				instanceId="instance-1"
				canInteract={true}
				inventory={{
					id: 0,
					slotCount: 46,
					slots: [{ slot: 36, type: "Diamond", label: "Diamond", count: 1 }],
				}}
			/>
		</QueryClientProvider>,
	)
}

const choose = async (label: string) => {
	fireEvent.contextMenu(screen.getByText("Slot 36").closest("div") ?? document.body)
	fireEvent.click(await screen.findByText(label))
}

describe("what the inventory says when the bot refuses", () => {
	it("says why a drop did not happen", async () => {
		drop.mockRejectedValue(refused)
		mount()

		await choose("Drop one")

		expect(await screen.findByText(shown)).toBeTruthy()
	})

	it("says why holding an item did not happen", async () => {
		hold.mockRejectedValue(refused)
		mount()

		await choose("Hold this")

		expect(await screen.findByText(shown)).toBeTruthy()
	})
})

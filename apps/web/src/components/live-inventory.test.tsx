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

const diamondIn = (slot: number, id = 0, slotCount = 46) => ({
	id,
	slotCount,
	slots: [{ slot, type: "Diamond", label: "Diamond", count: 1 }],
})

const mount = (inventory = diamondIn(36)) => {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	render(
		<QueryClientProvider client={client}>
			<LiveInventory instanceId="instance-1" canInteract={true} inventory={inventory} />
		</QueryClientProvider>,
	)
}

const openMenu = (slot: number) => {
	fireEvent.contextMenu(screen.getByText(`Slot ${slot}`).closest("div") ?? document.body)
}

const choose = async (label: string) => {
	openMenu(36)
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

describe("holding an item, which the client can only do from the hotbar", () => {
	it.each([
		{ named: "the first hotbar slot", inventory: diamondIn(36), slot: 36 },
		{ named: "the last hotbar slot", inventory: diamondIn(44), slot: 44 },
	])("offers to hold an item in $named", async ({ inventory, slot }) => {
		mount(inventory)

		openMenu(slot)

		expect(await screen.findByText("Hold this")).toBeTruthy()
	})

	it.each([
		{ named: "the main inventory", inventory: diamondIn(9), slot: 9 },
		{ named: "the offhand", inventory: diamondIn(45), slot: 45 },
		{ named: "armour", inventory: diamondIn(5), slot: 5 },
		{ named: "an open chest", inventory: diamondIn(0, 3, 27), slot: 0 },
	])(
		"offers no hold for an item in $named, but still offers the drop",
		async ({ inventory, slot }) => {
			mount(inventory)

			openMenu(slot)

			expect(await screen.findByText("Drop one")).toBeTruthy()
			expect(screen.queryByText("Hold this")).toBeNull()
		},
	)
})

import { describe, expect, it } from "vitest"
import { trackedStateSummary } from "./tracked-state"

describe("trackedStateSummary", () => {
	it("says so plainly when the client tracks nothing", () => {
		expect(
			trackedStateSummary({
				worldDataEnabled: false,
				inventoryDataEnabled: false,
				entityDataEnabled: false,
			}),
		).toBe("Nothing")
	})

	it("names the write-granting ones so an operator sees them without opening the editor", () => {
		expect(
			trackedStateSummary({
				worldDataEnabled: false,
				inventoryDataEnabled: true,
				entityDataEnabled: true,
			}),
		).toBe("Inventory, Entities")
	})

	it("keeps a stable order rather than the order they were switched on", () => {
		expect(
			trackedStateSummary({
				worldDataEnabled: true,
				inventoryDataEnabled: false,
				entityDataEnabled: true,
			}),
		).toBe("World, Entities")
	})
})

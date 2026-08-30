import { describe, expect, it } from "vitest"
import { presentHostStatus } from "./host-status"

describe("presentHostStatus", () => {
	it("presents every host status with a label and a status-family variant", () => {
		expect(presentHostStatus("pending")).toEqual({ label: "Pending", variant: "update" })
		expect(presentHostStatus("provisioning")).toEqual({
			label: "Provisioning",
			variant: "warning",
		})
		expect(presentHostStatus("ready")).toEqual({ label: "Ready", variant: "success" })
		expect(presentHostStatus("unreachable")).toEqual({
			label: "Unreachable",
			variant: "error",
		})
		expect(presentHostStatus("error")).toEqual({ label: "Error", variant: "error" })
	})
})

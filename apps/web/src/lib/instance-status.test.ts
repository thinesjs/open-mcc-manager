import { instanceStatusSchema } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import { describeExitCode, needsAttention, presentInstanceStatus } from "./instance-status"

describe("instance status presentation", () => {
	it("presents every status the contract allows, so no status can render blank", () => {
		for (const status of instanceStatusSchema.options) {
			const presentation = presentInstanceStatus(status)
			expect(presentation.label.length).toBeGreaterThan(0)
			expect(presentation.description.length).toBeGreaterThan(0)
		}
	})

	it("flags exactly the statuses an operator must act on", () => {
		expect(instanceStatusSchema.options.filter(needsAttention)).toEqual(["needs_auth", "error"])
	})

	it("explains the exit code mcc uses for a rejected login, which is never retried", () => {
		expect(describeExitCode(4)).toContain("Automatic restart is disabled")
	})

	it("explains a lost connection and an in-game kick distinctly", () => {
		expect(describeExitCode(3)).not.toBe(describeExitCode(2))
	})

	it("has nothing to say about an instance that has never exited", () => {
		expect(describeExitCode(null)).toBeUndefined()
	})
})

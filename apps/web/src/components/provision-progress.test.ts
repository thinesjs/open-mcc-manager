import { describe, expect, it } from "vitest"
import { stateForStep } from "./provision-progress"

describe("what each step in the timeline shows", () => {
	it("marks everything before the current step as done", () => {
		expect(stateForStep(0, 3, true)).toBe("done")
		expect(stateForStep(2, 3, true)).toBe("done")
	})

	it("marks everything after the current step as still waiting", () => {
		expect(stateForStep(5, 3, true)).toBe("waiting")
	})

	it("shows the current step running while provisioning continues", () => {
		expect(stateForStep(3, 3, true)).toBe("running")
	})

	it("shows the current step failed once provisioning has stopped", () => {
		expect(stateForStep(3, 3, false)).toBe("failed")
	})

	it("keeps earlier steps marked done after a failure, so the work already done is visible", () => {
		expect(stateForStep(0, 3, false)).toBe("done")
		expect(stateForStep(2, 3, false)).toBe("done")
	})

	it("does not mark later steps as failed, since they never ran", () => {
		expect(stateForStep(4, 3, false)).toBe("waiting")
	})
})

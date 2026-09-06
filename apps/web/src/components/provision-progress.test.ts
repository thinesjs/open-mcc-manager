import { describe, expect, it } from "vitest"
import { headlineFor, stateForStep } from "./provision-progress"

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

describe("what the timeline says when a run finishes", () => {
	it("marks every step done, not just the ones already passed", () => {
		expect(stateForStep(0, 3, false, true)).toBe("done")
		expect(stateForStep(9, 3, false, true)).toBe("done")
	})

	it("says the host is ready rather than naming the last step it ran", () => {
		expect(headlineFor(false, true, "Reloading systemd")).toBe("Ready to run bots")
	})

	it("still names the failing step when a run stopped", () => {
		expect(headlineFor(false, false, "Downloading the client")).toContain("Downloading the client")
	})

	it("shows the running step while it is still going", () => {
		expect(headlineFor(true, false, "Verifying the download")).toBe("Verifying the download")
	})
})

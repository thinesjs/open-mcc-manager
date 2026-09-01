import { describe, expect, it } from "vitest"
import { describeStateDrift, describeUnitDrift, summariseDrift } from "./drift"

describe("drift summary", () => {
	it("calls an unreachable host unknown, never converged", () => {
		const summary = summariseDrift({
			hostId: "h",
			reachable: false,
			reason: "Connection refused",
		})

		expect(summary.verdict).toBe("unknown")
		expect(summary.verdict).not.toBe("converged")
	})

	it("carries the reason forward so the operator knows what failed", () => {
		const summary = summariseDrift({ hostId: "h", reachable: false, reason: "Timed out" })
		if (summary.verdict !== "unknown") throw new Error("expected unknown")
		expect(summary.reason).toBe("Timed out")
	})

	it("only reports converged for a host it actually inspected", () => {
		expect(
			summariseDrift({ hostId: "h", reachable: true, unitDrift: [], stateDrift: [] }).verdict,
		).toBe("converged")
	})

	it("counts unit and state drift together so the badge matches the list", () => {
		const summary = summariseDrift({
			hostId: "h",
			reachable: true,
			unitDrift: [{ kind: "missing", unit: "open-mcc@.service" }],
			stateDrift: [{ instanceId: "abc", desired: "running", observed: "failed" }],
		})
		if (summary.verdict !== "drifted") throw new Error("expected drift")
		expect(summary.total).toBe(2)
	})

	it("explains each kind of unit drift distinctly", () => {
		const missing = describeUnitDrift({ kind: "missing", unit: "u" })
		const differs = describeUnitDrift({ kind: "differs", unit: "u" })
		expect(missing).not.toBe(differs)
		expect(differs).toContain("changed outside the manager")
	})

	it("names both the recorded and observed state so the mismatch is legible", () => {
		expect(describeStateDrift({ instanceId: "a", desired: "running", observed: "inactive" })).toBe(
			"Recorded as running, but systemd reports inactive.",
		)
	})
})

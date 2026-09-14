import { hostUnreachableReasonSchema } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import {
	configDriftDefeatsSafety,
	describeConfigDrift,
	describeStateDrift,
	describeUnitDrift,
	describeUnreachable,
	groupConfigDrift,
	remedyForGroup,
	summariseDrift,
} from "./drift"

describe("drift summary", () => {
	it("calls an unreachable host unknown, never converged", () => {
		const summary = summariseDrift({
			hostId: "h",
			reachable: false,
			reason: "unreachable",
		})

		expect(summary.verdict).toBe("unknown")
		expect(summary.verdict).not.toBe("converged")
	})

	it("carries the reason forward so the operator knows what failed", () => {
		const summary = summariseDrift({ hostId: "h", reachable: false, reason: "interrupted" })
		if (summary.verdict !== "unknown") throw new Error("expected unknown")
		expect(summary.reason).toBe("interrupted")
	})

	it("★ gives every reason its own words, so none of them reads as another", () => {
		const said = hostUnreachableReasonSchema.options.map(describeUnreachable)

		expect(new Set(said).size).toBe(said.length)
		expect(said.every((sentence) => sentence.trim().length > 0)).toBe(true)
	})

	it("only reports converged for a host it actually inspected", () => {
		expect(
			summariseDrift({
				hostId: "h",
				reachable: true,
				unitDrift: [],
				stateDrift: [],
				configDrift: [],
			}).verdict,
		).toBe("converged")
	})

	it("counts unit and state drift together so the badge matches the list", () => {
		const summary = summariseDrift({
			hostId: "h",
			reachable: true,
			unitDrift: [{ kind: "missing", unit: "open-mcc@.service" }],
			stateDrift: [{ instanceId: "abc", desired: "running", observed: "failed" }],
			configDrift: [],
		})
		if (summary.verdict !== "drifted") throw new Error("expected drift")
		expect(summary.total).toBe(2)
	})

	it("explains each kind of unit drift distinctly", () => {
		const missing = describeUnitDrift({ kind: "missing", unit: "u" })
		const differs = describeUnitDrift({ kind: "differs", unit: "u" })
		expect(missing).not.toBe(differs)
		expect(differs).toBe("Doesn't match what this version installs. Repair setup to update it.")
	})

	it("says a wedged client is wedged, not that systemd disagrees", () => {
		const described = describeStateDrift({ instanceId: "a", desired: "running", observed: "stuck" })
		expect(described).toContain("not connected")
		expect(described).not.toContain("stuck")
	})

	it("names both the recorded and observed state so the mismatch is legible", () => {
		expect(describeStateDrift({ instanceId: "a", desired: "running", observed: "inactive" })).toBe(
			"Expected running, found inactive.",
		)
	})
})

describe("grouping config drift by instance", () => {
	const entry = (instanceId: string, key: string, kind: "managed" | "fixed" | "unreachable") => ({
		instanceId,
		kind,
		key,
		expected: "x",
		actual: null,
	})

	it("collapses many keys on one instance into a single group", () => {
		const groups = groupConfigDrift([
			entry("a", "One", "managed"),
			entry("a", "Two", "managed"),
			entry("b", "Three", "managed"),
		])

		expect(groups).toHaveLength(2)
		expect(groups[0]?.entries).toHaveLength(2)
		expect(groups[1]?.instanceId).toBe("b")
	})

	it("keeps the instances in the order they were reported", () => {
		const groups = groupConfigDrift([entry("b", "One", "managed"), entry("a", "Two", "managed")])

		expect(groups.map((group) => group.instanceId)).toEqual(["b", "a"])
	})

	it("marks a group whose keys include one an operator may not choose", () => {
		const groups = groupConfigDrift([entry("a", "One", "managed"), entry("a", "Two", "fixed")])

		expect(groups[0]?.defeatsSafety).toBe(true)
	})

	it("marks a group whose live control never answered", () => {
		const groups = groupConfigDrift([entry("a", "ChatBot.McpServer", "unreachable")])

		expect(groups[0]?.neverAnswered).toBe(true)
	})

	it("tells an operator to restart, which is what actually repairs the config", () => {
		const [ordinary] = groupConfigDrift([entry("a", "One", "managed")])
		const [silent] = groupConfigDrift([entry("b", "ChatBot.McpServer", "unreachable")])

		expect(ordinary && remedyForGroup(ordinary, true)).toMatch(/Restarting this instance rewrites/)
		expect(silent && remedyForGroup(silent, true)).toMatch(/turn live control off/)
	})

	it("never tells an operator to restart a stopped bot, whose next start fixes it", () => {
		const [ordinary] = groupConfigDrift([entry("a", "One", "managed")])

		expect(ordinary && remedyForGroup(ordinary, false)).toBe("Fixed the next time it starts.")
	})

	it("returns nothing when there is no config drift", () => {
		expect(groupConfigDrift([])).toEqual([])
	})
})

describe("what the browser is told about a key the operator saved", () => {
	it("names neither the host's value nor anything about it", () => {
		const said = describeConfigDrift({
			instanceId: "i1",
			kind: "operator",
			key: "ChatBot.AutoAttack.Mode",
			expected: "single",
			actual: null,
		})

		expect(said).toBe("Does not match the saved value. Restart to restore it.")
	})

	it("does not claim the key was changed, which would be false when the host simply lost it", () => {
		const said = describeConfigDrift({
			instanceId: "i1",
			kind: "operator",
			key: "ChatBot.AutoEat.Threshold",
			expected: "5",
			actual: null,
		})

		expect(said).not.toContain("Changed")
		expect(said).not.toContain("Missing from the host")
	})

	it("does not treat it as a safety failure, because the operator chose the value", () => {
		expect(
			configDriftDefeatsSafety({
				instanceId: "i1",
				kind: "operator",
				key: "ChatBot.AutoAttack.Mode",
				expected: "single",
				actual: null,
			}),
		).toBe(false)
	})
})

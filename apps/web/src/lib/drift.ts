import type { HostReconciliation, StateDrift, UnitDrift } from "@open-mcc/contracts"

export type DriftSummary =
	| { verdict: "unknown"; reason: string }
	| { verdict: "converged" }
	| { verdict: "drifted"; unitDrift: UnitDrift[]; stateDrift: StateDrift[]; total: number }

export const summariseDrift = (reconciliation: HostReconciliation): DriftSummary => {
	if (!reconciliation.reachable) {
		return { verdict: "unknown", reason: reconciliation.reason }
	}
	const total = reconciliation.unitDrift.length + reconciliation.stateDrift.length
	if (total === 0) return { verdict: "converged" }
	return {
		verdict: "drifted",
		unitDrift: reconciliation.unitDrift,
		stateDrift: reconciliation.stateDrift,
		total,
	}
}

export const describeUnitDrift = (drift: UnitDrift): string => {
	if (drift.kind === "missing") return "Not installed."
	if (drift.kind === "differs") return "Modified outside the control plane."
	return "Present on host, not defined by the control plane."
}

export const describeStateDrift = (drift: StateDrift): string =>
	drift.observed === "stuck"
		? "Process running but not connected to a server."
		: `Expected ${drift.desired}, systemd reports ${drift.observed}.`

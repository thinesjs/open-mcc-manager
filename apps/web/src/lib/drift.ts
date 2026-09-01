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
	if (drift.kind === "missing") return `${drift.unit} is not installed on this host.`
	if (drift.kind === "differs") return `${drift.unit} was changed outside the manager.`
	return `${drift.unit} is installed but the manager does not define it.`
}

export const describeStateDrift = (drift: StateDrift): string =>
	`Recorded as ${drift.desired}, but systemd reports ${drift.observed}.`

import type {
	ConfigDriftPublic,
	HostReconciliation,
	StateDrift,
	UnitDrift,
} from "@open-mcc/contracts"

export type DriftSummary =
	| { verdict: "unknown"; reason: string }
	| { verdict: "converged" }
	| {
			verdict: "drifted"
			unitDrift: UnitDrift[]
			stateDrift: StateDrift[]
			configDrift: ConfigDriftPublic[]
			total: number
	  }

export const summariseDrift = (reconciliation: HostReconciliation): DriftSummary => {
	if (!reconciliation.reachable) {
		return { verdict: "unknown", reason: reconciliation.reason }
	}
	const total =
		reconciliation.unitDrift.length +
		reconciliation.stateDrift.length +
		reconciliation.configDrift.length
	if (total === 0) return { verdict: "converged" }
	return {
		verdict: "drifted",
		unitDrift: reconciliation.unitDrift,
		stateDrift: reconciliation.stateDrift,
		configDrift: reconciliation.configDrift,
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

export const describeConfigDrift = (drift: ConfigDriftPublic): string => {
	if (drift.kind === "section") {
		return `Should hold nothing, holds ${drift.actual}.`
	}
	if (drift.kind === "unreadable") {
		return "Holds a value the control plane cannot read."
	}
	if (drift.kind === "unreachable") {
		return `Live control is on, but nothing answers on port ${drift.expected}. The client could not claim it.`
	}
	if (drift.actual === null) {
		return `Missing from the host, expected ${drift.expected}.`
	}
	return `Set to ${drift.actual} on the host, expected ${drift.expected}.`
}

export const configDriftDefeatsSafety = (drift: ConfigDriftPublic): boolean =>
	drift.kind === "fixed" || drift.kind === "section"

export const configDriftIsSilentFailure = (drift: ConfigDriftPublic): boolean =>
	drift.kind === "unreachable"

export type ConfigDriftGroup = {
	instanceId: string
	entries: ConfigDriftPublic[]
	defeatsSafety: boolean
	neverAnswered: boolean
}

export const groupConfigDrift = (entries: readonly ConfigDriftPublic[]): ConfigDriftGroup[] => {
	const groups = new Map<string, ConfigDriftGroup>()
	for (const entry of entries) {
		const group = groups.get(entry.instanceId) ?? {
			instanceId: entry.instanceId,
			entries: [],
			defeatsSafety: false,
			neverAnswered: false,
		}
		group.entries.push(entry)
		group.defeatsSafety = group.defeatsSafety || configDriftDefeatsSafety(entry)
		group.neverAnswered = group.neverAnswered || configDriftIsSilentFailure(entry)
		groups.set(entry.instanceId, group)
	}
	return [...groups.values()]
}

export const remedyForGroup = (group: ConfigDriftGroup): string =>
	group.neverAnswered
		? "Restart this instance, or turn live control off if you do not need it."
		: "Restarting this instance rewrites its config from what the manager holds."

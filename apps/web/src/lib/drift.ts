import type {
	ConfigDriftPublic,
	HostReconciliation,
	HostUnreachableReason,
	RuntimeDrift,
	StateDrift,
	UnitDrift,
} from "@open-mcc/contracts"

const UNREACHABLE_REASONS: Record<HostUnreachableReason, string> = {
	misconfigured: "This host has no SSH key or no trusted fingerprint yet.",
	unprovisioned: "This host has not finished provisioning.",
	unreachable: "It did not answer.",
	interrupted: "It stopped answering part-way.",
	unreadable: "It answered with something OpenMCC could not read.",
	failed: "OpenMCC could not read it.",
}

export const describeUnreachable = (reason: HostUnreachableReason): string =>
	UNREACHABLE_REASONS[reason]

export type DriftSummary =
	| { verdict: "unknown"; reason: HostUnreachableReason }
	| { verdict: "converged" }
	| {
			verdict: "drifted"
			runtimeDrift: RuntimeDrift[]
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
		reconciliation.runtimeDrift.length +
		reconciliation.unitDrift.length +
		reconciliation.stateDrift.length +
		reconciliation.configDrift.length
	if (total === 0) return { verdict: "converged" }
	return {
		verdict: "drifted",
		runtimeDrift: reconciliation.runtimeDrift,
		unitDrift: reconciliation.unitDrift,
		stateDrift: reconciliation.stateDrift,
		configDrift: reconciliation.configDrift,
		total,
	}
}

export const describeRuntimeDrift = (drift: RuntimeDrift): string => {
	switch (drift.kind) {
		case "network-stack":
			return "Podman was upgraded. Repair setup to update it."
	}
}

export const describeUnitDrift = (drift: UnitDrift): string => {
	if (drift.kind === "missing") return "Not installed."
	if (drift.kind === "differs")
		return "Doesn't match what this version installs. Repair setup to update it."
	return "Present on host, not defined by the control plane."
}

export const describeStateDrift = (drift: StateDrift): string =>
	drift.observed === "stuck"
		? "Process running but not connected to a server."
		: `Expected ${drift.desired}, found ${drift.observed}.`

export const describeConfigDrift = (drift: ConfigDriftPublic): string => {
	switch (drift.kind) {
		case "section":
			return `Should hold nothing, holds ${drift.actual}.`
		case "unreadable":
			return "Holds a value the control plane cannot read."
		case "unreachable":
			return `Live control is on, but nothing answers on port ${drift.expected}. The client could not claim it.`
		case "operator":
			return "Does not match the saved value. Restart to restore it."
		case "managed":
		case "fixed":
			return drift.actual === null
				? `Missing from the host, expected ${drift.expected}.`
				: `Set to ${drift.actual} on the host, expected ${drift.expected}.`
	}
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

export const remedyForGroup = (group: ConfigDriftGroup, running: boolean): string => {
	if (!running) return "Fixed the next time it starts."
	return group.neverAnswered
		? "Restart this instance, or turn live control off if you do not need it."
		: "Restarting this instance rewrites its config from what the manager holds."
}

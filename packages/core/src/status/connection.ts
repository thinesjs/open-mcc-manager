import { INSTANCE_INTERRUPTED_TO_DOWN_MS, type StatusEventKind } from "@open-mcc/contracts"
import type { ConnectionSignal } from "@open-mcc/contracts/boundary/journal"

export type ConnectionState = "joined" | "interrupted" | "down" | "never_joined" | "unknown"

export type ConnectionCurrent = {
	state: ConnectionState
	since: Date | null
	pid: string | null
}

export type ConnectionChange = {
	state: ConnectionState
	at: Date
	pid: string | null
	event: StatusEventKind | undefined
	reason: string | undefined
}

export const UNOBSERVED_CONNECTION: ConnectionCurrent = {
	state: "unknown",
	since: null,
	pid: null,
}

const KICK_HINTS = ["kick", "banned"]

const looksLikeKick = (reason: string | undefined): boolean => {
	if (reason === undefined) return false
	const lowered = reason.toLowerCase()
	return KICK_HINTS.some((hint) => lowered.includes(hint))
}

export const changesFromSignals = (
	current: ConnectionCurrent,
	signals: readonly ConnectionSignal[],
): ConnectionChange[] => {
	const changes: ConnectionChange[] = []
	let state = current.state

	for (const signal of signals) {
		if (signal.kind === "joined") {
			if (state === "joined") continue
			changes.push({
				state: "joined",
				at: signal.at,
				pid: signal.pid,
				event: state === "unknown" ? "instance.joined" : "instance.reconnected",
				reason: undefined,
			})
			state = "joined"
			continue
		}

		if (signal.kind === "stopped") {
			if (state === "down") continue
			changes.push({
				state: "down",
				at: signal.at,
				pid: signal.pid,
				event: "instance.stopped",
				reason: undefined,
			})
			state = "down"
			continue
		}

		if (state === "interrupted" || state === "down") continue
		changes.push({
			state: "interrupted",
			at: signal.at,
			pid: signal.pid,
			event: looksLikeKick(signal.reason) ? "instance.kicked" : "instance.connection_lost",
			reason: signal.reason,
		})
		state = "interrupted"
	}

	return changes
}

export const escalateIfStillDown = (
	current: ConnectionCurrent,
	now: Date,
	graceMs: number = INSTANCE_INTERRUPTED_TO_DOWN_MS,
): ConnectionChange | undefined => {
	if (current.state !== "interrupted" || current.since === null) return undefined
	if (now.getTime() - current.since.getTime() < graceMs) return undefined
	return {
		state: "down",
		at: now,
		pid: current.pid,
		event: "instance.disconnected",
		reason: undefined,
	}
}

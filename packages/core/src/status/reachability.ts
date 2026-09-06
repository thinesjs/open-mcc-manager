import { HOST_SUSPECT_TO_DOWN_MS, type StatusEventKind } from "@open-mcc/contracts"

export type ReachabilityState = "up" | "suspect" | "down" | "unknown"

export type ReachabilityCurrent = {
	state: ReachabilityState
	failureStartedAt: Date | null
}

export type ReachabilityDecision = {
	state: ReachabilityState
	failureStartedAt: Date | null
	event: StatusEventKind | undefined
	changed: boolean
}

export const UNOBSERVED: ReachabilityCurrent = { state: "unknown", failureStartedAt: null }

export const nextReachability = (
	current: ReachabilityCurrent,
	reached: boolean,
	now: Date,
	suspectToDownMs: number = HOST_SUSPECT_TO_DOWN_MS,
): ReachabilityDecision => {
	if (reached) {
		if (current.state === "up") {
			return { state: "up", failureStartedAt: null, event: undefined, changed: false }
		}
		const event: StatusEventKind | undefined =
			current.state === "down"
				? "host.recovered"
				: current.state === "suspect"
					? "host.check_recovered"
					: undefined
		return { state: "up", failureStartedAt: null, event, changed: true }
	}

	if (current.state === "down") {
		return {
			state: "down",
			failureStartedAt: current.failureStartedAt,
			event: undefined,
			changed: false,
		}
	}

	const failingSince =
		current.state === "suspect" && current.failureStartedAt !== null
			? current.failureStartedAt
			: now

	if (now.getTime() - failingSince.getTime() >= suspectToDownMs) {
		return {
			state: "down",
			failureStartedAt: failingSince,
			event: "host.unreachable",
			changed: true,
		}
	}

	if (current.state === "suspect") {
		return { state: "suspect", failureStartedAt: failingSince, event: undefined, changed: false }
	}

	return {
		state: "suspect",
		failureStartedAt: failingSince,
		event: "host.check_failed",
		changed: true,
	}
}

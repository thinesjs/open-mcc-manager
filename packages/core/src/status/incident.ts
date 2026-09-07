import { FLAPPING_WINDOW_MS, isFlapping, type StatusEventKind } from "@open-mcc/contracts"

export type IncidentDecision = {
	readonly incidentId: string | null
	readonly opened: boolean
	readonly closing: string | null
}

const CLOSES = new Set<StatusEventKind>(["instance.joined", "instance.reconnected"])

export const nextIncident = (
	current: string | null,
	state: string,
	event: StatusEventKind | undefined,
	fresh: () => string,
): IncidentDecision => {
	if (event !== undefined && CLOSES.has(event)) {
		return { incidentId: null, opened: false, closing: current }
	}
	if (state === "joined") return { incidentId: null, opened: false, closing: current }
	if (state === "interrupted") {
		if (current !== null) return { incidentId: current, opened: false, closing: null }
		return { incidentId: fresh(), opened: true, closing: null }
	}
	return { incidentId: current, opened: false, closing: null }
}

export const incidentOfEvent = (decision: IncidentDecision): string | null =>
	decision.incidentId ?? decision.closing

export const escalationKeyFor = (incidentId: string): string => `escalate:${incidentId}`

export const FLAPPING_LOSS_EVENTS: readonly StatusEventKind[] = [
	"instance.connection_lost",
	"instance.kicked",
]

export const countsAsLoss = (event: StatusEventKind | undefined): boolean =>
	event !== undefined && FLAPPING_LOSS_EVENTS.some((candidate) => candidate === event)

export type LossWindow = { readonly since: Date; readonly until: Date }

export const lossWindow = (at: Date, windowMs: number = FLAPPING_WINDOW_MS): LossWindow => ({
	since: new Date(at.getTime() - windowMs),
	until: at,
})

export const worthClaimingFlapping = (recorded: readonly Date[], at: Date): boolean =>
	isFlapping(recorded, at)

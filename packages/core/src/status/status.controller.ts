import {
	type Availability,
	EMPTY_AVAILABILITY,
	type HostUptime,
	RANGE_SECONDS,
	type StatusEventKind,
	type StatusEventView,
	type StatusRange,
	type StatusState,
	type StatusSummary,
} from "@open-mcc/contracts"
import type { Db } from "@open-mcc/db"
import { nanoid } from "nanoid"
import type { OrgScope } from "../host/host.repository"
import { nextReachability, type ReachabilityCurrent, UNOBSERVED } from "./reachability"
import { rollUpDay } from "./rollup"
import { createStatusRepository, type StatusRepository } from "./status.repository"

export type StatusTransactionBundle = { status: StatusRepository }

export type WithStatusTransaction = <T>(
	fn: (repos: StatusTransactionBundle) => Promise<T>,
) => Promise<T>

export const createStatusControllerTransaction = (db: Db): WithStatusTransaction => {
	const withTransaction: WithStatusTransaction = (fn) =>
		db.transaction().execute((tx) => fn({ status: createStatusRepository(tx) }))
	return withTransaction
}

export type StatusControllerDeps = {
	withTransaction: WithStatusTransaction
	hostNames: (scope: OrgScope) => Promise<{ id: string; name: string }[]>
	now: () => Date
}

export type HostObservation = {
	hostId: string
	hostName: string
	reached: boolean
}

const HOST_REACHABILITY = "host.reachability" as const

const availabilityOver = (
	intervals: readonly { state: StatusState; startedAt: Date; endedAt: Date | null }[],
	since: Date,
	until: Date,
): Availability => {
	const clipped = intervals.map((interval) => ({
		state: interval.state,
		startedAt: interval.startedAt < since ? since : interval.startedAt,
		endedAt: interval.endedAt ?? until,
	}))
	const seconds = Math.max(0, Math.round((until.getTime() - since.getTime()) / 1000))
	if (seconds === 0) return EMPTY_AVAILABILITY
	return rollUpDay(clipped, since)
}

export const createStatusController = (deps: StatusControllerDeps) => ({
	recordHostReachability: async (scope: OrgScope, observation: HostObservation): Promise<void> => {
		const now = deps.now()
		await deps.withTransaction(async ({ status }) => {
			const existing = await status.findCondition(
				scope,
				{ hostId: observation.hostId },
				HOST_REACHABILITY,
			)
			const current: ReachabilityCurrent =
				existing === undefined
					? UNOBSERVED
					: {
							state:
								existing.state === "up" || existing.state === "suspect" || existing.state === "down"
									? existing.state
									: "unknown",
							failureStartedAt: existing.failureStartedAt,
						}

			const decision = nextReachability(current, observation.reached, now)

			if (!decision.changed && existing !== undefined) {
				await status.touchCondition(scope, existing.id, now)
				return
			}

			const subject = { hostId: observation.hostId }
			const incidentId =
				decision.state === "down"
					? (existing?.activeIncidentId ?? nanoid())
					: decision.state === "up"
						? null
						: (existing?.activeIncidentId ?? null)

			const event =
				decision.event === undefined
					? undefined
					: await status.recordEvent(scope, {
							subjectType: "host",
							subjectId: observation.hostId,
							subjectLabel: observation.hostName,
							hostId: observation.hostId,
							instanceId: null,
							kind: decision.event,
							occurredAt: now,
							observedAt: now,
							lastCorroboratedAt: now,
							incidentId,
							primarySource: "host_probe",
							sources: ["host_probe"],
							sourceKey: null,
							detail: {},
						})

			await status.closeOpenInterval(scope, subject, HOST_REACHABILITY, now, event?.id ?? null)
			await status.openInterval(
				scope,
				subject,
				HOST_REACHABILITY,
				decision.state,
				now,
				event?.id ?? null,
			)
			await status.upsertCondition(
				scope,
				subject,
				HOST_REACHABILITY,
				{
					state: decision.state,
					observedAt: now,
					failureStartedAt: decision.failureStartedAt,
					activeIncidentId: decision.state === "up" ? null : incidentId,
					detail: {},
				},
				now,
			)
		})
	},

	summary: async (scope: OrgScope, range: StatusRange): Promise<StatusSummary> => {
		const since = new Date(deps.now().getTime() - RANGE_SECONDS[range] * 1000)
		const names = await deps.hostNames(scope)
		return await deps.withTransaction(async ({ status }) => {
			const conditions = await status.listConditions(scope, HOST_REACHABILITY)
			const intervals = await status.listIntervals(scope, {
				dimension: HOST_REACHABILITY,
				since,
			})
			const hosts = names.map((host) => {
				const condition = conditions.find((entry) => entry.hostId === host.id)
				const mine = intervals.filter((entry) => entry.hostId === host.id)
				return {
					hostId: host.id,
					hostName: host.name,
					state: condition?.state ?? "unknown",
					since: condition?.startedAt ?? since,
					lastCheckedAt: condition?.lastObservedAt ?? since,
					availability: availabilityOver(mine, since, deps.now()),
				}
			})
			return {
				hosts,
				answering: hosts.filter((host) => host.state === "up").length,
				total: hosts.length,
			}
		})
	},

	events: async (
		scope: OrgScope,
		range: StatusRange,
		limit: number,
	): Promise<StatusEventView[]> => {
		const since = new Date(deps.now().getTime() - RANGE_SECONDS[range] * 1000)
		return await deps.withTransaction(async ({ status }) => {
			const rows = await status.listEvents(scope, { since, limit })
			return rows.map((row) => ({
				id: row.id,
				kind: row.kind,
				subjectLabel: row.subjectLabel,
				hostId: row.hostId,
				instanceId: row.instanceId,
				occurredAt: row.occurredAt,
			}))
		})
	},
})

export type StatusController = ReturnType<typeof createStatusController>

import {
	type Availability,
	EMPTY_AVAILABILITY,
	granularityFor,
	type HostUptime,
	RANGE_SECONDS,
	rangeWithinRetention,
	type StatusEventKind,
	type StatusEventView,
	type StatusRange,
	type StatusState,
	type StatusSummary,
} from "@open-mcc/contracts"
import type { Db } from "@open-mcc/db"
import { nanoid } from "nanoid"
import type { OrgScope } from "../host/host.repository"
import type { ConnectionChange, ConnectionCurrent } from "./connection"
import { UNOBSERVED_CONNECTION } from "./connection"
import { nextReachability, type ReachabilityCurrent, UNOBSERVED } from "./reachability"
import { bucketStarts, rollUpWindow, SECONDS_PER_BUCKET } from "./rollup"
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
	instanceNames: (scope: OrgScope) => Promise<{ id: string; name: string }[]>
	retentionDays: number
	now: () => Date
}

export type HostObservation = {
	hostId: string
	hostName: string
	reached: boolean
}

const HOST_REACHABILITY = "host.reachability" as const

const INSTANCE_CONNECTION = "instance.connection" as const

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
	if (until.getTime() <= since.getTime()) return EMPTY_AVAILABILITY
	return rollUpWindow(clipped, since, until)
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

	recordInstanceConnection: async (
		scope: OrgScope,
		instance: { id: string; name: string },
		changes: readonly ConnectionChange[],
	): Promise<void> => {
		if (changes.length === 0) return
		await deps.withTransaction(async ({ status }) => {
			const subject = { instanceId: instance.id }
			for (const change of changes) {
				const event =
					change.event === undefined
						? undefined
						: await status.recordEvent(scope, {
								subjectType: "instance",
								subjectId: instance.id,
								subjectLabel: instance.name,
								hostId: null,
								instanceId: instance.id,
								kind: change.event,
								occurredAt: change.at,
								observedAt: deps.now(),
								lastCorroboratedAt: deps.now(),
								incidentId: null,
								primarySource: "journal",
								sources: ["journal"],
								sourceKey: `${instance.id}:${change.at.toISOString()}:${change.event}`,
								detail: change.reason === undefined ? {} : { reason: change.reason },
							})

				const closed = await status.closeOpenInterval(
					scope,
					subject,
					INSTANCE_CONNECTION,
					change.at,
					event?.id ?? null,
				)
				const startAt =
					closed?.endedAt !== null && closed?.endedAt !== undefined && closed.endedAt > change.at
						? closed.endedAt
						: change.at
				await status.openInterval(
					scope,
					subject,
					INSTANCE_CONNECTION,
					change.state,
					startAt,
					event?.id ?? null,
				)
				await status.upsertCondition(
					scope,
					subject,
					INSTANCE_CONNECTION,
					{
						state: change.state,
						observedAt: deps.now(),
						failureStartedAt: change.state === "joined" ? null : change.at,
						activeIncidentId: null,
						detail: change.reason === undefined ? {} : { reason: change.reason },
					},
					change.at,
				)
			}
		})
	},

	connectionCursor: async (scope: OrgScope, instanceId: string): Promise<string | null> =>
		await deps.withTransaction(({ status }) => status.readCursor(scope, instanceId, "journal")),

	saveConnectionCursor: async (
		scope: OrgScope,
		instanceId: string,
		cursor: string,
	): Promise<void> => {
		await deps.withTransaction(({ status }) =>
			status.writeCursor(scope, instanceId, "journal", cursor, deps.now()),
		)
	},

	currentConnection: async (scope: OrgScope, instanceId: string): Promise<ConnectionCurrent> => {
		const condition = await deps.withTransaction(({ status }) =>
			status.findCondition(scope, { instanceId }, INSTANCE_CONNECTION),
		)
		if (condition === undefined) return UNOBSERVED_CONNECTION
		const state =
			condition.state === "joined" ||
			condition.state === "interrupted" ||
			condition.state === "down" ||
			condition.state === "never_joined"
				? condition.state
				: "unknown"
		return { state, since: condition.startedAt, pid: null }
	},

	summary: async (scope: OrgScope, requested: StatusRange): Promise<StatusSummary> => {
		const range = rangeWithinRetention(requested, deps.retentionDays)
		const since = new Date(deps.now().getTime() - RANGE_SECONDS[range] * 1000)
		const names = await deps.hostNames(scope)
		return await deps.withTransaction(async ({ status }) => {
			const conditions = await status.listConditions(scope, HOST_REACHABILITY)
			const intervals = await status.listIntervals(scope, {
				dimension: HOST_REACHABILITY,
				since,
			})
			const now = deps.now()
			const granularity = granularityFor(range)
			const starts = bucketStarts(since, now, granularity)
			const step = SECONDS_PER_BUCKET[granularity] * 1000
			const hosts = names.map((host) => {
				const condition = conditions.find((entry) => entry.hostId === host.id)
				const mine = intervals.filter((entry) => entry.hostId === host.id)
				const clipped = mine.map((interval) => ({
					state: interval.state,
					startedAt: interval.startedAt,
					endedAt: interval.endedAt ?? now,
				}))
				return {
					hostId: host.id,
					hostName: host.name,
					state: condition?.state ?? "unknown",
					since: condition?.startedAt ?? since,
					lastCheckedAt: condition?.lastObservedAt ?? since,
					availability: availabilityOver(mine, since, now),
					buckets: starts.map((start) => ({
						start: start.toISOString(),
						availability: rollUpWindow(clipped, start, new Date(start.getTime() + step)),
					})),
				}
			})
			const botNames = await deps.instanceNames(scope)
			const botConditions = await status.listConditions(scope, INSTANCE_CONNECTION)
			const botIntervals = await status.listIntervals(scope, {
				dimension: INSTANCE_CONNECTION,
				since,
			})
			const bots = botNames.map((bot) => {
				const condition = botConditions.find((entry) => entry.instanceId === bot.id)
				const mine = botIntervals.filter((entry) => entry.instanceId === bot.id)
				const clipped = mine.map((interval) => ({
					state: interval.state,
					startedAt: interval.startedAt,
					endedAt: interval.endedAt ?? now,
				}))
				return {
					instanceId: bot.id,
					instanceName: bot.name,
					state: condition?.state ?? "unknown",
					availability: availabilityOver(mine, since, now),
					buckets: starts.map((start) => ({
						start: start.toISOString(),
						availability: rollUpWindow(clipped, start, new Date(start.getTime() + step)),
					})),
					lastChangeAt: condition?.startedAt ?? null,
				}
			})

			return {
				hosts,
				bots,
				answering: hosts.filter((host) => host.state === "up").length,
				total: hosts.length,
				granularity,
				retentionDays: deps.retentionDays,
			}
		})
	},

	events: async (
		scope: OrgScope,
		range: StatusRange,
		limit: number,
		filter: { hostId?: string; instanceId?: string } = {},
	): Promise<StatusEventView[]> => {
		const since = new Date(deps.now().getTime() - RANGE_SECONDS[range] * 1000)
		return await deps.withTransaction(async ({ status }) => {
			const rows = await status.listEvents(scope, {
				since,
				limit,
				...(filter.hostId === undefined ? {} : { hostId: filter.hostId }),
				...(filter.instanceId === undefined ? {} : { instanceId: filter.instanceId }),
			})
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

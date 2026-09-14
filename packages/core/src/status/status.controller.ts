import {
	type Availability,
	BUCKET_SECONDS,
	EMPTY_AVAILABILITY,
	FLAPPING_WINDOW_MS,
	INSTANCE_INTERRUPTED_TO_DOWN_MS,
	RANGE_SECONDS,
	rangeWithinRetention,
	type StatusEventView,
	type StatusRange,
	type StatusState,
	type StatusSummary,
} from "@open-mcc/contracts"
import type { Db } from "@open-mcc/db"
import { nanoid } from "nanoid"
import type { OrgScope } from "../host/host.repository"
import { asSqlRunner, type SqlRunner } from "../job/executor-adapter"
import type { SendJob } from "../job/job.queue"
import { STATUS_ESCALATE_QUEUE } from "../job/queue-setup"
import { announce } from "../notification/announce"
import {
	createNotificationRepository,
	type NotificationRepository,
} from "../notification/notification.repository"
import type { ConnectionChange, ConnectionCurrent } from "./connection"
import { CONNECTION_STATES, escalateIfStillDown, UNOBSERVED_CONNECTION } from "./connection"
import {
	countsAsLoss,
	escalationKeyFor,
	FLAPPING_LOSS_EVENTS,
	incidentOfEvent,
	lossWindow,
	nextIncident,
	worthClaimingFlapping,
} from "./incident"
import { nextReachability, type ReachabilityCurrent, UNOBSERVED } from "./reachability"
import { bucketStartsFor, rollUpBuckets, rollUpWindow } from "./rollup"
import { createStatusRepository, type StatusRepository } from "./status.repository"

export type StatusTransactionBundle = {
	status: StatusRepository
	notifications: NotificationRepository
	runner: SqlRunner
}

export type WithStatusTransaction = <T>(
	fn: (repos: StatusTransactionBundle) => Promise<T>,
) => Promise<T>

export const createStatusControllerTransaction = (db: Db): WithStatusTransaction => {
	const withTransaction: WithStatusTransaction = (fn) =>
		db.transaction().execute((tx) =>
			fn({
				status: createStatusRepository(tx),
				notifications: createNotificationRepository(tx),
				runner: asSqlRunner(tx),
			}),
		)
	return withTransaction
}

export type StatusControllerDeps = {
	withTransaction: WithStatusTransaction
	sendJob: SendJob
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
		await deps.withTransaction(async ({ status, notifications, runner }) => {
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
			const eventIncidentId = incidentId ?? existing?.activeIncidentId ?? null

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
							incidentId: eventIncidentId,
							primarySource: "host_probe",
							sources: ["host_probe"],
							sourceKey: null,
							detail: {},
						})

			if (event !== undefined) {
				await announce(
					scope,
					{
						statusEventId: event.id,
						kind: event.kind,
						subjectType: "host",
						subjectId: observation.hostId,
						subjectName: observation.hostName,
						...(eventIncidentId === null ? {} : { incidentId: eventIncidentId }),
					},
					{ notifications, sendJob: deps.sendJob, runner },
				)
			}

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

	escalateInstance: async (
		scope: OrgScope,
		instance: { id: string; name: string },
		incidentId: string,
	): Promise<boolean> =>
		await deps.withTransaction(async ({ status, notifications, runner }) => {
			const subject = { instanceId: instance.id }
			const condition = await status.findCondition(scope, subject, INSTANCE_CONNECTION)
			if (!condition || condition.activeIncidentId !== incidentId) return false

			const connectionState = CONNECTION_STATES.find((candidate) => candidate === condition.state)
			if (connectionState === undefined) return false

			const change = escalateIfStillDown(
				{ state: connectionState, since: condition.failureStartedAt, pid: null },
				deps.now(),
			)
			if (!change) return false

			const claimed = await status.claimEscalation(
				scope,
				condition.id,
				incidentId,
				change.state,
				deps.now(),
			)
			if (!claimed) return false

			const event = await status.recordEvent(scope, {
				subjectType: "instance",
				subjectId: instance.id,
				subjectLabel: instance.name,
				hostId: null,
				instanceId: instance.id,
				kind: "instance.disconnected",
				occurredAt: change.at,
				observedAt: deps.now(),
				lastCorroboratedAt: deps.now(),
				incidentId,
				primarySource: "journal",
				sources: ["journal"],
				sourceKey: escalationKeyFor(incidentId),
				detail: {},
			})
			if (event === undefined) return false

			await announce(
				scope,
				{
					statusEventId: event.id,
					kind: event.kind,
					subjectType: "instance",
					subjectId: instance.id,
					subjectName: instance.name,
					incidentId,
				},
				{ notifications, sendJob: deps.sendJob, runner },
			)

			await status.closeOpenInterval(scope, subject, INSTANCE_CONNECTION, change.at, event.id)
			await status.openInterval(
				scope,
				subject,
				INSTANCE_CONNECTION,
				change.state,
				change.at,
				event.id,
			)
			return true
		}),

	recordInstanceConnection: async (
		scope: OrgScope,
		instance: { id: string; name: string },
		changes: readonly ConnectionChange[],
	): Promise<void> => {
		if (changes.length === 0) return
		await deps.withTransaction(async ({ status, notifications, runner }) => {
			const subject = { instanceId: instance.id }
			const opening = await status.findCondition(scope, subject, INSTANCE_CONNECTION)
			let incidentId = opening?.activeIncidentId ?? null
			for (const change of changes) {
				const decision = nextIncident(incidentId, change.state, change.event, nanoid)
				incidentId = decision.incidentId
				const eventIncidentId = incidentOfEvent(decision)
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
								incidentId: eventIncidentId,
								primarySource: "journal",
								sources: ["journal"],
								sourceKey: `${instance.id}:${change.at.toISOString()}:${change.event}`,
								detail: {},
							})

				if (event !== undefined) {
					await announce(
						scope,
						{
							statusEventId: event.id,
							kind: event.kind,
							subjectType: "instance",
							subjectId: instance.id,
							subjectName: instance.name,
							...(eventIncidentId === null ? {} : { incidentId: eventIncidentId }),
						},
						{ notifications, sendJob: deps.sendJob, runner },
					)
				}

				if (decision.opened && incidentId !== null) {
					const scheduled = await deps.sendJob(
						STATUS_ESCALATE_QUEUE,
						{ organizationId: scope.organizationId, instanceId: instance.id, incidentId },
						runner,
						{ startAfterSeconds: Math.ceil(INSTANCE_INTERRUPTED_TO_DOWN_MS / 1000) },
					)
					if (scheduled === null) {
						throw new Error(`the check on ${instance.name} could not be scheduled`)
					}
				}

				if (countsAsLoss(change.event) && opening !== undefined) {
					const losses = await status.recentLossesAt(
						scope,
						instance.id,
						lossWindow(change.at),
						FLAPPING_LOSS_EVENTS,
					)
					if (
						worthClaimingFlapping(losses, change.at) &&
						(await status.claimFlapping(scope, opening.id, change.at, FLAPPING_WINDOW_MS))
					) {
						const flapped = await status.recordEvent(scope, {
							subjectType: "instance",
							subjectId: instance.id,
							subjectLabel: instance.name,
							hostId: null,
							instanceId: instance.id,
							kind: "instance.flapping",
							occurredAt: change.at,
							observedAt: deps.now(),
							lastCorroboratedAt: deps.now(),
							incidentId,
							primarySource: "journal",
							sources: ["journal"],
							sourceKey: `flap:${instance.id}:${change.at.toISOString()}`,
							detail: {},
						})
						if (flapped !== undefined) {
							await announce(
								scope,
								{
									statusEventId: flapped.id,
									kind: flapped.kind,
									subjectType: "instance",
									subjectId: instance.id,
									subjectName: instance.name,
								},
								{ notifications, sendJob: deps.sendJob, runner },
							)
						}
					}
				}

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
						activeIncidentId: incidentId,
						detail: {},
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
		const now = deps.now()
		const starts = bucketStartsFor(range, now)
		const since = starts[0] ?? now
		const bucketSeconds = BUCKET_SECONDS[range]
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
					buckets: rollUpBuckets(clipped, starts, bucketSeconds),
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
					buckets: rollUpBuckets(clipped, starts, bucketSeconds),
					lastChangeAt: condition?.startedAt ?? null,
				}
			})

			return {
				hosts,
				bots,
				answering: hosts.filter((host) => host.state === "up").length,
				total: hosts.length,
				bucketSeconds,
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

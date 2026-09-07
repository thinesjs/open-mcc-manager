import type {
	Executor,
	StatusConditionRow,
	StatusDimension,
	StatusEventInsert,
	StatusEventKind,
	StatusEventRow,
	StatusIntervalRow,
	StatusSource,
	StatusState,
} from "@open-mcc/db"
import { sql } from "kysely"
import { nanoid } from "nanoid"
import type { OrgScope } from "../host/host.repository"

export type SubjectRef =
	| { hostId: string; instanceId?: undefined }
	| { instanceId: string; hostId?: undefined }

export type ConditionPatch = {
	state: StatusState
	observedAt: Date
	failureStartedAt: Date | null
	activeIncidentId: string | null
	detail: Record<string, string>
}

const subjectColumns = (subject: SubjectRef) => ({
	hostId: subject.hostId ?? null,
	instanceId: subject.instanceId ?? null,
})

export const createStatusRepository = (db: Executor) => ({
	findCondition: async (
		scope: OrgScope,
		subject: SubjectRef,
		dimension: StatusDimension,
	): Promise<StatusConditionRow | undefined> => {
		let query = db
			.selectFrom("statusCondition")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.where("dimension", "=", dimension)
		query =
			subject.hostId === undefined
				? query.where("instanceId", "=", subject.instanceId)
				: query.where("hostId", "=", subject.hostId)
		return await query.executeTakeFirst()
	},

	upsertCondition: async (
		scope: OrgScope,
		subject: SubjectRef,
		dimension: StatusDimension,
		patch: ConditionPatch,
		startedAt: Date,
	): Promise<StatusConditionRow> => {
		const values = {
			id: nanoid(),
			organizationId: scope.organizationId,
			...subjectColumns(subject),
			dimension,
			state: patch.state,
			startedAt,
			lastObservedAt: patch.observedAt,
			failureStartedAt: patch.failureStartedAt,
			activeIncidentId: patch.activeIncidentId,
			detail: JSON.stringify(patch.detail),
		}
		const updates = {
			state: patch.state,
			startedAt,
			lastObservedAt: patch.observedAt,
			failureStartedAt: patch.failureStartedAt,
			activeIncidentId: patch.activeIncidentId,
			detail: JSON.stringify(patch.detail),
		}

		if (subject.hostId === undefined) {
			return await db
				.insertInto("statusCondition")
				.values(values)
				.onConflict((conflict) =>
					conflict
						.columns(["organizationId", "instanceId", "dimension"])
						.where("instanceId", "is not", null)
						.doUpdateSet(updates),
				)
				.returningAll()
				.executeTakeFirstOrThrow()
		}

		return await db
			.insertInto("statusCondition")
			.values(values)
			.onConflict((conflict) =>
				conflict
					.columns(["organizationId", "hostId", "dimension"])
					.where("hostId", "is not", null)
					.doUpdateSet(updates),
			)
			.returningAll()
			.executeTakeFirstOrThrow()
	},

	touchCondition: async (scope: OrgScope, conditionId: string, observedAt: Date): Promise<void> => {
		await db
			.updateTable("statusCondition")
			.set({ lastObservedAt: observedAt })
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", conditionId)
			.execute()
	},

	openInterval: async (
		scope: OrgScope,
		subject: SubjectRef,
		dimension: StatusDimension,
		state: StatusState,
		startedAt: Date,
		startEventId: string | null,
	): Promise<StatusIntervalRow> =>
		await db
			.insertInto("statusInterval")
			.values({
				id: nanoid(),
				organizationId: scope.organizationId,
				...subjectColumns(subject),
				dimension,
				state,
				startedAt,
				endedAt: null,
				startEventId,
				endEventId: null,
			})
			.returningAll()
			.executeTakeFirstOrThrow(),

	closeOpenInterval: async (
		scope: OrgScope,
		subject: SubjectRef,
		dimension: StatusDimension,
		endedAt: Date,
		endEventId: string | null,
	): Promise<StatusIntervalRow | undefined> => {
		let query = db
			.updateTable("statusInterval")
			.set({
				endedAt: sql<Date>`greatest(${endedAt}::timestamp, "startedAt")`,
				endEventId,
			})
			.where("organizationId", "=", scope.organizationId)
			.where("dimension", "=", dimension)
			.where("endedAt", "is", null)
		query =
			subject.hostId === undefined
				? query.where("instanceId", "=", subject.instanceId)
				: query.where("hostId", "=", subject.hostId)
		return await query.returningAll().executeTakeFirst()
	},

	recentLossesAt: async (
		scope: OrgScope,
		instanceId: string,
		window: { since: Date; until: Date },
		kinds: readonly StatusEventKind[],
	): Promise<Date[]> => {
		if (kinds.length === 0) return []
		const rows = await db
			.selectFrom("statusEvent")
			.select("occurredAt")
			.where("organizationId", "=", scope.organizationId)
			.where("instanceId", "=", instanceId)
			.where("kind", "in", kinds)
			.where("occurredAt", ">=", window.since)
			.where("occurredAt", "<=", window.until)
			.orderBy("occurredAt", "desc")
			.execute()
		return rows.map((row) => row.occurredAt)
	},

	claimEscalation: async (
		scope: OrgScope,
		conditionId: string,
		incidentId: string,
		state: StatusState,
		observedAt: Date,
	): Promise<boolean> => {
		const result = await db
			.updateTable("statusCondition")
			.set({ state, lastObservedAt: observedAt, startedAt: observedAt })
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", conditionId)
			.where("activeIncidentId", "=", incidentId)
			.where("state", "=", "interrupted")
			.executeTakeFirst()
		return result.numUpdatedRows === 1n
	},

	claimFlapping: async (
		scope: OrgScope,
		conditionId: string,
		now: Date,
		cooldownMs: number,
	): Promise<boolean> => {
		const result = await db
			.updateTable("statusCondition")
			.set({ lastFlappedAt: now })
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", conditionId)
			.where((eb) =>
				eb.or([
					eb("lastFlappedAt", "is", null),
					eb("lastFlappedAt", "<=", new Date(now.getTime() - cooldownMs)),
				]),
			)
			.executeTakeFirst()
		return result.numUpdatedRows === 1n
	},

	recordEvent: async (
		scope: OrgScope,
		event: Omit<StatusEventInsert, "id" | "organizationId">,
	): Promise<StatusEventRow | undefined> =>
		await db
			.insertInto("statusEvent")
			.values({ ...event, id: nanoid(), organizationId: scope.organizationId })
			.onConflict((conflict) => conflict.doNothing())
			.returningAll()
			.executeTakeFirst(),

	listEvents: async (
		scope: OrgScope,
		options: { since: Date; limit: number; hostId?: string; instanceId?: string },
	): Promise<StatusEventRow[]> => {
		let query = db
			.selectFrom("statusEvent")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.where("occurredAt", ">=", options.since)
		if (options.hostId !== undefined) query = query.where("hostId", "=", options.hostId)
		if (options.instanceId !== undefined) {
			query = query.where("instanceId", "=", options.instanceId)
		}
		return await query
			.orderBy("occurredAt", "desc")
			.orderBy("id", "desc")
			.limit(options.limit)
			.execute()
	},

	listIntervals: async (
		scope: OrgScope,
		options: { dimension: StatusDimension; since: Date },
	): Promise<StatusIntervalRow[]> =>
		await db
			.selectFrom("statusInterval")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.where("dimension", "=", options.dimension)
			.where((eb) => eb.or([eb("endedAt", "is", null), eb("endedAt", ">=", options.since)]))
			.orderBy("startedAt", "asc")
			.execute(),

	readCursor: async (
		scope: OrgScope,
		instanceId: string,
		source: StatusSource,
	): Promise<string | null> => {
		const row = await db
			.selectFrom("statusSourceCursor")
			.select(["cursor"])
			.where("organizationId", "=", scope.organizationId)
			.where("instanceId", "=", instanceId)
			.where("source", "=", source)
			.executeTakeFirst()
		return row?.cursor ?? null
	},

	writeCursor: async (
		scope: OrgScope,
		instanceId: string,
		source: StatusSource,
		cursor: string,
		observedAt: Date,
	): Promise<void> => {
		await db
			.insertInto("statusSourceCursor")
			.values({
				id: nanoid(),
				organizationId: scope.organizationId,
				instanceId,
				source,
				generation: "1",
				cursor,
				lastObservedAt: observedAt,
			})
			.onConflict((conflict) =>
				conflict
					.columns(["organizationId", "instanceId", "source"])
					.doUpdateSet({ cursor, lastObservedAt: observedAt }),
			)
			.execute()
	},

	listConditions: async (
		scope: OrgScope,
		dimension: StatusDimension,
	): Promise<StatusConditionRow[]> =>
		await db
			.selectFrom("statusCondition")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.where("dimension", "=", dimension)
			.execute(),
})

export type StatusRepository = ReturnType<typeof createStatusRepository>

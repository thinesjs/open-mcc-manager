import type {
	Executor,
	StatusConditionRow,
	StatusDimension,
	StatusEventInsert,
	StatusEventRow,
	StatusIntervalRow,
	StatusState,
} from "@open-mcc/db"
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
		const columns = subjectColumns(subject)
		const conflictTarget = subject.hostId === undefined ? "instanceId" : "hostId"
		return await db
			.insertInto("statusCondition")
			.values({
				id: nanoid(),
				organizationId: scope.organizationId,
				...columns,
				dimension,
				state: patch.state,
				startedAt,
				lastObservedAt: patch.observedAt,
				failureStartedAt: patch.failureStartedAt,
				activeIncidentId: patch.activeIncidentId,
				detail: JSON.stringify(patch.detail),
			})
			.onConflict((conflict) =>
				conflict.columns(["organizationId", conflictTarget, "dimension"]).doUpdateSet({
					state: patch.state,
					startedAt,
					lastObservedAt: patch.observedAt,
					failureStartedAt: patch.failureStartedAt,
					activeIncidentId: patch.activeIncidentId,
					detail: JSON.stringify(patch.detail),
				}),
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
			.set({ endedAt, endEventId })
			.where("organizationId", "=", scope.organizationId)
			.where("dimension", "=", dimension)
			.where("endedAt", "is", null)
		query =
			subject.hostId === undefined
				? query.where("instanceId", "=", subject.instanceId)
				: query.where("hostId", "=", subject.hostId)
		return await query.returningAll().executeTakeFirst()
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

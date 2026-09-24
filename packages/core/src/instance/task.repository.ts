import type {
	Executor,
	InstanceSignalCursorRow,
	InstanceSignalInsert,
	InstanceSignalKind,
	InstanceSignalRow,
	InstanceSignalSource,
	InstanceTaskRow,
	InstanceTaskRunRow,
	InstanceTaskStepRow,
	InstanceTaskTimeRow,
	TaskRunOutcome,
	TaskTrigger,
} from "@open-mcc/db"
import { nanoid } from "nanoid"
import type { OrgScope } from "../host/host.repository"
import { InternalError } from "../lib/errors"
import type { IntervalArm } from "./task"

export type TaskValues = {
	instanceId: string
	name: string
	stepDelaySeconds: number
	enabled: boolean
	timezone: string
	onFirstLogin: boolean
	onLogin: boolean
	onRespawn: boolean
	intervalMinSeconds: number | null
	intervalMaxSeconds: number | null
}

export type TaskTimeValues = {
	daysOfWeek: string
	minuteOfDay: number
}

export type TaskParts = {
	task: InstanceTaskRow
	steps: InstanceTaskStepRow[]
	times: InstanceTaskTimeRow[]
	runs: InstanceTaskRunRow[]
}

export type SignalValues = {
	instanceId: string
	kind: InstanceSignalKind
	identity: string
	process: string | null
	firstForProcess: boolean
	occurredAt: Date
	observedAt: Date
}

export const createTaskRepository = (db: Executor) => ({
	insert: async (scope: OrgScope, values: TaskValues): Promise<InstanceTaskRow> => {
		const row = await db
			.insertInto("instanceTask")
			.values({ ...values, id: nanoid(), organizationId: scope.organizationId })
			.returningAll()
			.executeTakeFirst()
		if (!row) throw new InternalError("Task insert returned no row")
		return row
	},

	update: async (
		scope: OrgScope,
		id: string,
		values: TaskValues,
	): Promise<InstanceTaskRow | undefined> =>
		await db
			.updateTable("instanceTask")
			.set({
				name: values.name,
				stepDelaySeconds: values.stepDelaySeconds,
				enabled: values.enabled,
				timezone: values.timezone,
				onFirstLogin: values.onFirstLogin,
				onLogin: values.onLogin,
				onRespawn: values.onRespawn,
				intervalMinSeconds: values.intervalMinSeconds,
				intervalMaxSeconds: values.intervalMaxSeconds,
				intervalNextRunAt: null,
				intervalObservedAt: null,
			})
			.where("id", "=", id)
			.where("instanceId", "=", values.instanceId)
			.where("organizationId", "=", scope.organizationId)
			.returningAll()
			.executeTakeFirst(),

	replaceSteps: async (scope: OrgScope, taskId: string, commands: readonly string[]) => {
		await db
			.deleteFrom("instanceTaskStep")
			.where("taskId", "=", taskId)
			.where("organizationId", "=", scope.organizationId)
			.execute()
		if (commands.length === 0) return
		await db
			.insertInto("instanceTaskStep")
			.values(
				commands.map((command, position) => ({
					id: nanoid(),
					organizationId: scope.organizationId,
					taskId,
					position,
					command,
				})),
			)
			.execute()
	},

	replaceTimes: async (scope: OrgScope, taskId: string, times: readonly TaskTimeValues[]) => {
		await db
			.deleteFrom("instanceTaskTime")
			.where("taskId", "=", taskId)
			.where("organizationId", "=", scope.organizationId)
			.execute()
		if (times.length === 0) return
		await db
			.insertInto("instanceTaskTime")
			.values(
				times.map((time) => ({
					id: nanoid(),
					organizationId: scope.organizationId,
					taskId,
					daysOfWeek: time.daysOfWeek,
					minuteOfDay: time.minuteOfDay,
				})),
			)
			.execute()
	},

	listForInstance: async (
		scope: OrgScope,
		instanceId: string,
		runsSince: Date,
	): Promise<TaskParts[]> => {
		const tasks = await db
			.selectFrom("instanceTask")
			.selectAll()
			.where("instanceId", "=", instanceId)
			.where("organizationId", "=", scope.organizationId)
			.orderBy("createdAt", "asc")
			.execute()
		return await partsFor(db, scope, tasks, runsSince)
	},

	findById: async (scope: OrgScope, id: string): Promise<InstanceTaskRow | undefined> =>
		await db
			.selectFrom("instanceTask")
			.selectAll()
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.executeTakeFirst(),

	deleteReturning: async (scope: OrgScope, id: string): Promise<InstanceTaskRow | undefined> =>
		await db
			.deleteFrom("instanceTask")
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.returningAll()
			.executeTakeFirst(),

	listEnabledAcrossOrganizations: async (runsSince: Date): Promise<TaskParts[]> => {
		const tasks = await db
			.selectFrom("instanceTask")
			.selectAll()
			.where("enabled", "=", true)
			.orderBy("createdAt", "asc")
			.execute()
		return await partsFor(db, undefined, tasks, runsSince)
	},

	stepsFor: async (scope: OrgScope, taskId: string): Promise<InstanceTaskStepRow[]> =>
		await db
			.selectFrom("instanceTaskStep")
			.selectAll()
			.where("taskId", "=", taskId)
			.where("organizationId", "=", scope.organizationId)
			.orderBy("position", "asc")
			.execute(),

	armInterval: async (scope: OrgScope, id: string, arm: IntervalArm): Promise<void> => {
		await db
			.updateTable("instanceTask")
			.set({ intervalNextRunAt: arm.nextRunAt, intervalObservedAt: arm.observedAt })
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.execute()
	},

	claimRun: async (
		scope: OrgScope,
		taskId: string,
		trigger: TaskTrigger,
		claimKey: string,
		startedAt: Date,
	): Promise<string | undefined> => {
		const row = await db
			.insertInto("instanceTaskRun")
			.values({
				id: nanoid(),
				organizationId: scope.organizationId,
				taskId,
				trigger,
				claimKey,
				outcome: "running",
				startedAt,
				stepsSent: 0,
			})
			.onConflict((conflict) =>
				conflict.columns(["organizationId", "taskId", "claimKey"]).doNothing(),
			)
			.returning("id")
			.executeTakeFirst()
		return row?.id
	},

	finishRun: async (
		scope: OrgScope,
		runId: string,
		outcome: TaskRunOutcome,
		stepsSent: number,
		error: string | null,
		finishedAt: Date,
	): Promise<void> => {
		await db
			.updateTable("instanceTaskRun")
			.set({ outcome, stepsSent, error, finishedAt })
			.where("id", "=", runId)
			.where("organizationId", "=", scope.organizationId)
			.execute()
	},

	recordTaskOutcome: async (
		scope: OrgScope,
		taskId: string,
		ranAt: Date,
		error: string | null,
	): Promise<void> => {
		await db
			.updateTable("instanceTask")
			.set({ lastRunAt: ranAt, lastRunError: error })
			.where("id", "=", taskId)
			.where("organizationId", "=", scope.organizationId)
			.execute()
	},

	abandonStaleRuns: async (startedBefore: Date, reason: string): Promise<number> => {
		const result = await db
			.updateTable("instanceTaskRun")
			.set({ outcome: "abandoned", error: reason, finishedAt: startedBefore })
			.where("outcome", "=", "running")
			.where("startedAt", "<", startedBefore)
			.executeTakeFirst()
		return Number(result.numUpdatedRows ?? 0n)
	},

	pruneRuns: async (startedBefore: Date): Promise<number> => {
		const result = await db
			.deleteFrom("instanceTaskRun")
			.where("startedAt", "<", startedBefore)
			.where("outcome", "!=", "running")
			.executeTakeFirst()
		return Number(result.numDeletedRows ?? 0n)
	},

	recordSignal: async (scope: OrgScope, values: SignalValues): Promise<boolean> => {
		const insert: InstanceSignalInsert = {
			id: nanoid(),
			organizationId: scope.organizationId,
			instanceId: values.instanceId,
			kind: values.kind,
			identity: values.identity,
			process: values.process,
			firstForProcess: values.firstForProcess,
			occurredAt: values.occurredAt,
			observedAt: values.observedAt,
		}
		const row = await db
			.insertInto("instanceSignal")
			.values(insert)
			.onConflict((conflict) =>
				conflict.columns(["organizationId", "instanceId", "kind", "identity"]).doNothing(),
			)
			.returning("id")
			.executeTakeFirst()
		return row !== undefined
	},

	hasJoinedAs: async (scope: OrgScope, instanceId: string, process: string): Promise<boolean> => {
		const row = await db
			.selectFrom("instanceSignal")
			.select("id")
			.where("organizationId", "=", scope.organizationId)
			.where("instanceId", "=", instanceId)
			.where("kind", "=", "login")
			.where("process", "=", process)
			.executeTakeFirst()
		return row !== undefined
	},

	signalsSince: async (
		scope: OrgScope,
		instanceId: string,
		since: Date,
	): Promise<InstanceSignalRow[]> =>
		await db
			.selectFrom("instanceSignal")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.where("instanceId", "=", instanceId)
			.where("occurredAt", ">=", since)
			.orderBy("occurredAt", "desc")
			.execute(),

	pruneSignals: async (occurredBefore: Date): Promise<number> => {
		const result = await db
			.deleteFrom("instanceSignal")
			.where("occurredAt", "<", occurredBefore)
			.executeTakeFirst()
		return Number(result.numDeletedRows ?? 0n)
	},

	readSignalCursor: async (
		scope: OrgScope,
		instanceId: string,
		source: InstanceSignalSource,
	): Promise<string | null> => {
		const row: Pick<InstanceSignalCursorRow, "cursor"> | undefined = await db
			.selectFrom("instanceSignalCursor")
			.select("cursor")
			.where("organizationId", "=", scope.organizationId)
			.where("instanceId", "=", instanceId)
			.where("source", "=", source)
			.executeTakeFirst()
		return row?.cursor ?? null
	},

	writeSignalCursor: async (
		scope: OrgScope,
		instanceId: string,
		source: InstanceSignalSource,
		cursor: string,
		observedAt: Date,
	): Promise<void> => {
		await db
			.insertInto("instanceSignalCursor")
			.values({
				id: nanoid(),
				organizationId: scope.organizationId,
				instanceId,
				source,
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
})

const partsFor = async (
	db: Executor,
	scope: OrgScope | undefined,
	tasks: readonly InstanceTaskRow[],
	runsSince: Date,
): Promise<TaskParts[]> => {
	if (tasks.length === 0) return []
	const ids = tasks.map((task) => task.id)

	let stepQuery = db.selectFrom("instanceTaskStep").selectAll().where("taskId", "in", ids)
	let timeQuery = db.selectFrom("instanceTaskTime").selectAll().where("taskId", "in", ids)
	let runQuery = db
		.selectFrom("instanceTaskRun")
		.selectAll()
		.where("taskId", "in", ids)
		.where("startedAt", ">=", runsSince)
		.orderBy("startedAt", "desc")

	if (scope !== undefined) {
		stepQuery = stepQuery.where("organizationId", "=", scope.organizationId)
		timeQuery = timeQuery.where("organizationId", "=", scope.organizationId)
		runQuery = runQuery.where("organizationId", "=", scope.organizationId)
	}

	const steps = await stepQuery.orderBy("position", "asc").execute()
	const times = await timeQuery.orderBy("minuteOfDay", "asc").execute()
	const runs = await runQuery.execute()

	return tasks.map((task) => ({
		task,
		steps: steps.filter((step) => step.taskId === task.id),
		times: times.filter((time) => time.taskId === task.id),
		runs: runs.filter((run) => run.taskId === task.id),
	}))
}

export type TaskRepository = ReturnType<typeof createTaskRepository>

export type InstanceTaskRepos = Pick<
	TaskRepository,
	| "insert"
	| "update"
	| "replaceSteps"
	| "replaceTimes"
	| "listForInstance"
	| "findById"
	| "deleteReturning"
	| "recordSignal"
	| "hasJoinedAs"
	| "readSignalCursor"
	| "writeSignalCursor"
>

import type { InstanceSignalRow, InstanceTaskRow } from "@open-mcc/db"
import type { OrgScope } from "../host/host.repository"
import {
	evenJitter,
	type IntervalJitter,
	intervalArmOf,
	intervalClaimOf,
	intervalPlan,
	signalClaims,
	TASK_ABANDONED_AFTER_MS,
	TASK_ABANDONED_REASON,
	TASK_RUN_RETENTION_DAYS,
	TASK_SIGNAL_CATCH_UP_MS,
	TASK_SIGNAL_RETENTION_DAYS,
	TASK_TICK_MS,
	type TaskClaim,
	timeClaims,
	wantsJoinSignal,
	wantsRespawnSignal,
} from "./task"
import type { TaskParts } from "./task.repository"
import { InstanceTaskStepsFailedError } from "./task-run"

export const TASK_SCHEDULER_ACTOR_LABEL = "task scheduler"

export type TaskSignalNeeds = {
	join: boolean
	respawn: boolean
}

export type TaskSchedulerRun = {
	considered: number
	fired: string[]
	failed: Array<{ taskId: string; reason: string }>
	unclaimed: number
	observed: number
}

export type TaskSchedulerDeps = {
	enabledTasks: (runsSince: Date) => Promise<TaskParts[]>
	isRunning: (scope: OrgScope, instanceId: string) => Promise<boolean>
	observeSignals: (
		scope: OrgScope,
		instanceId: string,
		needs: TaskSignalNeeds,
		at: Date,
	) => Promise<void>
	signalsSince: (
		scope: OrgScope,
		instanceId: string,
		since: Date,
	) => Promise<readonly InstanceSignalRow[]>
	armInterval: (
		scope: OrgScope,
		taskId: string,
		arm: { nextRunAt: Date; observedAt: Date },
	) => Promise<void>
	claimRun: (
		scope: OrgScope,
		taskId: string,
		claim: TaskClaim,
		at: Date,
	) => Promise<string | undefined>
	send: (parts: TaskParts) => Promise<number>
	finishRun: (
		scope: OrgScope,
		runId: string,
		outcome: "sent" | "failed",
		stepsSent: number,
		error: string | null,
		at: Date,
	) => Promise<void>
	recordTaskOutcome: (
		scope: OrgScope,
		taskId: string,
		ranAt: Date,
		error: string | null,
	) => Promise<void>
	sweep: (
		abandonBefore: Date,
		runsBefore: Date,
		signalsBefore: Date,
		reason: string,
	) => Promise<void>
	now: () => Date
	jitter?: IntervalJitter
	describeFailure: (error: Error | string) => string
	onError?: (message: string, error: Error | string) => void
}

const UNKNOWN_FAILURE = "Unknown task failure"

const scopeOf = (row: InstanceTaskRow): OrgScope => ({ organizationId: row.organizationId })

const needsOf = (tasks: readonly TaskParts[]): TaskSignalNeeds => ({
	join: tasks.some((each) => wantsJoinSignal(each.task)),
	respawn: tasks.some((each) => wantsRespawnSignal(each.task)),
})

const byInstance = (tasks: readonly TaskParts[]): Map<string, TaskParts[]> => {
	const grouped = new Map<string, TaskParts[]>()
	for (const parts of tasks) {
		const key = `${parts.task.organizationId}:${parts.task.instanceId}`
		const found = grouped.get(key)
		if (found === undefined) grouped.set(key, [parts])
		else found.push(parts)
	}
	return grouped
}

export const runTaskSchedulerTick = async (deps: TaskSchedulerDeps): Promise<TaskSchedulerRun> => {
	const at = deps.now()
	const jitter = deps.jitter ?? evenJitter
	const run: TaskSchedulerRun = { considered: 0, fired: [], failed: [], unclaimed: 0, observed: 0 }

	const retainedSince = new Date(at.getTime() - TASK_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000)

	try {
		await deps.sweep(
			new Date(at.getTime() - TASK_ABANDONED_AFTER_MS),
			retainedSince,
			new Date(at.getTime() - TASK_SIGNAL_RETENTION_DAYS * 24 * 60 * 60 * 1000),
			TASK_ABANDONED_REASON,
		)
	} catch (error) {
		deps.onError?.("Task runs could not be swept", error instanceof Error ? error : UNKNOWN_FAILURE)
	}

	const tasks = await deps.enabledTasks(retainedSince)
	run.considered = tasks.length

	for (const group of byInstance(tasks).values()) {
		const first = group[0]
		if (first === undefined) continue
		const scope = scopeOf(first.task)
		const instanceId = first.task.instanceId

		let running = false
		try {
			running = await deps.isRunning(scope, instanceId)
		} catch (error) {
			deps.onError?.(
				`Task scheduler could not read bot ${instanceId}`,
				error instanceof Error ? error : UNKNOWN_FAILURE,
			)
			continue
		}

		const needs = needsOf(group)
		if (running && (needs.join || needs.respawn)) {
			try {
				await deps.observeSignals(scope, instanceId, needs, at)
				run.observed += 1
			} catch (error) {
				deps.onError?.(
					`Task scheduler could not read signals for ${instanceId}`,
					error instanceof Error ? error : UNKNOWN_FAILURE,
				)
			}
		}

		let signals: readonly InstanceSignalRow[] = []
		if (needs.join || needs.respawn) {
			try {
				signals = await deps.signalsSince(
					scope,
					instanceId,
					new Date(at.getTime() - TASK_SIGNAL_CATCH_UP_MS),
				)
			} catch (error) {
				deps.onError?.(
					`Task scheduler could not stand up signals for ${instanceId}`,
					error instanceof Error ? error : UNKNOWN_FAILURE,
				)
			}
		}

		for (const parts of group) {
			await considerTask(deps, parts, { at, running, signals, jitter }, run)
		}
	}

	return run
}

type TaskMoment = {
	at: Date
	running: boolean
	signals: readonly InstanceSignalRow[]
	jitter: IntervalJitter
}

const considerTask = async (
	deps: TaskSchedulerDeps,
	parts: TaskParts,
	moment: TaskMoment,
	run: TaskSchedulerRun,
): Promise<void> => {
	const scope = scopeOf(parts.task)
	const claims: TaskClaim[] = []

	try {
		claims.push(...signalClaims(parts.task, moment.signals))
		claims.push(
			...timeClaims({ row: parts.task, steps: parts.steps, times: parts.times }, moment.at),
		)
	} catch (error) {
		const reason = error instanceof Error ? error.message : UNKNOWN_FAILURE
		run.failed.push({ taskId: parts.task.id, reason })
		await deps.recordTaskOutcome(scope, parts.task.id, moment.at, reason).catch(() => undefined)
		return
	}

	const plan = intervalPlan(parts.task, moment.at, moment.running, moment.jitter)
	const arm = intervalArmOf(plan)
	if (arm !== undefined) {
		try {
			await deps.armInterval(scope, parts.task.id, arm)
		} catch (error) {
			deps.onError?.(
				`Task ${parts.task.id} could not arm its interval`,
				error instanceof Error ? error : UNKNOWN_FAILURE,
			)
			return
		}
	}
	const intervalClaim = intervalClaimOf(plan)
	if (intervalClaim !== undefined) claims.push(intervalClaim)

	if (claims.length === 0) return
	if (!moment.running) return

	for (const claim of claims) {
		let runId: string | undefined
		try {
			runId = await deps.claimRun(scope, parts.task.id, claim, moment.at)
		} catch (error) {
			run.failed.push({
				taskId: parts.task.id,
				reason: error instanceof Error ? error.message : UNKNOWN_FAILURE,
			})
			deps.onError?.(
				`Task ${parts.task.id} could not be claimed`,
				error instanceof Error ? error : UNKNOWN_FAILURE,
			)
			continue
		}

		if (runId === undefined) {
			run.unclaimed += 1
			continue
		}

		await carryOut(deps, parts, claim, runId, moment.at, run)
	}
}

const carryOut = async (
	deps: TaskSchedulerDeps,
	parts: TaskParts,
	claim: TaskClaim,
	runId: string,
	at: Date,
	run: TaskSchedulerRun,
): Promise<void> => {
	const scope = scopeOf(parts.task)
	try {
		const stepsSent = await deps.send(parts)
		run.fired.push(parts.task.id)
		await deps.finishRun(scope, runId, "sent", stepsSent, null, deps.now())
		await deps.recordTaskOutcome(scope, parts.task.id, at, null)
	} catch (error) {
		const failure = error instanceof Error ? error : UNKNOWN_FAILURE
		const reason =
			error instanceof InstanceTaskStepsFailedError ? error.message : deps.describeFailure(failure)
		const stepsSent = error instanceof InstanceTaskStepsFailedError ? error.stepsSent : 0
		run.failed.push({ taskId: parts.task.id, reason })
		deps.onError?.(`Task ${parts.task.id} failed on trigger ${claim.trigger}`, failure)
		await deps
			.finishRun(scope, runId, "failed", stepsSent, reason, deps.now())
			.catch(() => undefined)
		await deps.recordTaskOutcome(scope, parts.task.id, at, reason).catch(() => undefined)
	}
}

export type TaskSchedulerHandle = {
	stop: () => void
}

export const startTaskScheduler = (
	deps: TaskSchedulerDeps,
	intervalMs: number = TASK_TICK_MS,
): TaskSchedulerHandle => {
	let running = false
	const tick = async () => {
		if (running) return
		running = true
		try {
			await runTaskSchedulerTick(deps)
		} catch (error) {
			deps.onError?.("Task scheduler tick failed", error instanceof Error ? error : UNKNOWN_FAILURE)
		} finally {
			running = false
		}
	}

	const timer = setInterval(() => {
		void tick()
	}, intervalMs)
	timer.unref?.()

	return { stop: () => clearInterval(timer) }
}

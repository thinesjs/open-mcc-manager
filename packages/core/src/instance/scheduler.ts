import type { InstanceCommandRow } from "@open-mcc/db"
import { isDue, startOfLocalDay } from "./due"
import { parseDaysOfWeek } from "./schedule"

export const SCHEDULER_TICK_MS = 30_000

export const SCHEDULER_ACTOR_LABEL = "scheduler"

export type SchedulerRun = {
	considered: number
	fired: string[]
	failed: Array<{ id: string; reason: string }>
	skipped: number
	unclaimed: number
}

export type SchedulerDeps = {
	dueCommands: () => Promise<InstanceCommandRow[]>
	send: (row: InstanceCommandRow) => Promise<void>
	claimRun: (id: string, ranAt: Date, notRunSince: Date) => Promise<boolean>
	recordRun: (id: string, ranAt: Date, error: string | null) => Promise<void>
	now: () => Date
	onError?: (message: string, error: Error | string) => void
}

export const candidateFor = (row: InstanceCommandRow) => ({
	daysOfWeek: parseDaysOfWeek(row.daysOfWeek),
	minuteOfDay: row.minuteOfDay,
	timezone: row.timezone,
	enabled: row.enabled,
	lastRunAt: row.lastRunAt,
})

export const runSchedulerTick = async (deps: SchedulerDeps): Promise<SchedulerRun> => {
	const at = deps.now()
	const rows = await deps.dueCommands()

	const run: SchedulerRun = {
		considered: rows.length,
		fired: [],
		failed: [],
		skipped: 0,
		unclaimed: 0,
	}

	for (const row of rows) {
		let due = false
		try {
			due = isDue(candidateFor(row), at)
		} catch (error) {
			const reason = error instanceof Error ? error.message : UNKNOWN_FAILURE
			run.failed.push({ id: row.id, reason })
			await deps.recordRun(row.id, at, reason).catch(() => undefined)
			continue
		}

		if (!due) {
			run.skipped += 1
			continue
		}

		let claimed = false
		try {
			claimed = await deps.claimRun(row.id, at, startOfLocalDay(row, at))
		} catch (error) {
			const reason = error instanceof Error ? error.message : UNKNOWN_FAILURE
			run.failed.push({ id: row.id, reason })
			deps.onError?.(
				`Scheduled command ${row.id} could not be claimed`,
				error instanceof Error ? error : reason,
			)
			continue
		}

		if (!claimed) {
			run.unclaimed += 1
			continue
		}

		try {
			await deps.send(row)
			run.fired.push(row.id)
		} catch (error) {
			const reason = error instanceof Error ? error.message : UNKNOWN_FAILURE
			run.failed.push({ id: row.id, reason })
			deps.onError?.(`Scheduled command ${row.id} failed`, error instanceof Error ? error : reason)
			await deps.recordRun(row.id, at, reason).catch(() => undefined)
		}
	}

	return run
}

const UNKNOWN_FAILURE = "Unknown scheduler failure"

export type SchedulerHandle = {
	stop: () => void
}

export const startScheduler = (
	deps: SchedulerDeps,
	intervalMs: number = SCHEDULER_TICK_MS,
): SchedulerHandle => {
	let running = false
	const tick = async () => {
		if (running) return
		running = true
		try {
			await runSchedulerTick(deps)
		} catch (error) {
			deps.onError?.("Scheduler tick failed", error instanceof Error ? error : UNKNOWN_FAILURE)
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

import { randomUUID } from "node:crypto"
import type { JobRow } from "@open-mcc/db"
import { backoffFor } from "./job.repository"

export const JOB_TICK_MS = 10_000

export type JobOutcome = "done" | "retry" | "abandon"

export type JobHandler = (job: JobRow) => Promise<JobOutcome>

export type JobRunnerDeps = {
	kinds: readonly string[]
	handlers: Record<string, JobHandler>
	claimNext: (kind: string, claimId: string, now: Date) => Promise<JobRow | undefined>
	complete: (id: string, claimId: string, at: Date) => Promise<boolean>
	release: (
		id: string,
		claimId: string,
		reason: string,
		runAfter: Date,
		exhausted: boolean,
		at: Date,
	) => Promise<boolean>
	now: () => Date
	newClaimId?: () => string
	onError?: (message: string, error: Error | string) => void
}

export type JobRunResult = {
	completed: string[]
	retried: string[]
	abandoned: string[]
}

export const isExhausted = (job: JobRow): boolean => job.attempts >= job.maxAttempts

export const nextRunAfter = (job: JobRow, now: Date): Date =>
	new Date(now.getTime() + backoffFor(job.attempts))

export const runJobTick = async (deps: JobRunnerDeps): Promise<JobRunResult> => {
	const result: JobRunResult = { completed: [], retried: [], abandoned: [] }

	for (const kind of deps.kinds) {
		const handler = deps.handlers[kind]
		if (!handler) continue

		for (;;) {
			const claimId = (deps.newClaimId ?? randomUUID)()
			const now = deps.now()
			const job = await deps.claimNext(kind, claimId, now)
			if (!job) break

			let outcome: JobOutcome = "retry"
			let reason = "Job did not report a reason"
			try {
				outcome = await handler(job)
			} catch (error) {
				reason = error instanceof Error ? error.message : String(error)
				deps.onError?.(`Job ${job.id} (${kind}) threw`, error instanceof Error ? error : reason)
			}

			const at = deps.now()
			if (outcome === "done") {
				await deps.complete(job.id, claimId, at)
				result.completed.push(job.id)
				continue
			}

			const exhausted = outcome === "abandon" || isExhausted(job)
			await deps.release(job.id, claimId, reason, nextRunAfter(job, at), exhausted, at)
			if (exhausted) result.abandoned.push(job.id)
			else result.retried.push(job.id)
		}
	}

	return result
}

export type JobRunnerHandle = { stop: () => void }

export const startJobRunner = (
	deps: JobRunnerDeps,
	intervalMs: number = JOB_TICK_MS,
): JobRunnerHandle => {
	let running = false
	const tick = async () => {
		if (running) return
		running = true
		try {
			await runJobTick(deps)
		} catch (error) {
			deps.onError?.("Job tick failed", error instanceof Error ? error : String(error))
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

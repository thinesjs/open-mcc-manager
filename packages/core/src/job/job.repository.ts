import type { Executor, JobRow } from "@open-mcc/db"
import { sql } from "kysely"

export const JOB_LEASE_MS = 5 * 60 * 1000

export const JOB_BASE_BACKOFF_MS = 30_000

export const JOB_MAX_BACKOFF_MS = 60 * 60 * 1000

export const JOB_DEFAULT_MAX_ATTEMPTS = 8

export const backoffFor = (attempts: number): number => {
	const exponent = Math.max(0, Math.min(attempts - 1, 20))
	return Math.min(JOB_BASE_BACKOFF_MS * 2 ** exponent, JOB_MAX_BACKOFF_MS)
}

export type EnqueueJob = {
	id: string
	organizationId: string
	kind: string
	payload: Record<string, string>
	runAfter?: Date
	maxAttempts?: number
}

export const createJobRepository = (db: Executor) => ({
	enqueue: async (job: EnqueueJob): Promise<JobRow> => {
		const result = await sql<JobRow>`
			insert into "job" ("id", "organizationId", "kind", "payload", "runAfter", "maxAttempts")
			values (
				${job.id},
				${job.organizationId},
				${job.kind},
				${JSON.stringify(job.payload)}::jsonb,
				${job.runAfter ?? new Date()},
				${job.maxAttempts ?? JOB_DEFAULT_MAX_ATTEMPTS}
			)
			returning *
		`.execute(db)
		const row = result.rows[0]
		if (!row) throw new Error(`Could not enqueue job ${job.id}`)
		return row
	},

	claimNext: async (
		kind: string,
		claimId: string,
		now: Date,
		leaseMs: number = JOB_LEASE_MS,
	): Promise<JobRow | undefined> => {
		const staleBefore = new Date(now.getTime() - leaseMs)
		const result = await sql<JobRow>`
			update "job" set
				"claimId" = ${claimId},
				"claimedAt" = ${now},
				"attempts" = "attempts" + 1
			where "id" = (
				select "id" from "job"
				where "kind" = ${kind}
					and "completedAt" is null
					and "failedAt" is null
					and "runAfter" <= ${now}
					and ("claimId" is null or "claimedAt" < ${staleBefore})
					and "attempts" < "maxAttempts"
				order by "runAfter" asc
				for update skip locked
				limit 1
			)
			returning *
		`.execute(db)
		return result.rows[0]
	},

	complete: async (id: string, claimId: string, at: Date): Promise<boolean> => {
		const result = await sql`
			update "job" set
				"completedAt" = ${at},
				"claimId" = null,
				"claimedAt" = null,
				"lastError" = null
			where "id" = ${id} and "claimId" = ${claimId}
		`.execute(db)
		return Number(result.numAffectedRows ?? 0) > 0
	},

	release: async (
		id: string,
		claimId: string,
		reason: string,
		runAfter: Date,
		exhausted: boolean,
		at: Date,
	): Promise<boolean> => {
		const result = await sql`
			update "job" set
				"claimId" = null,
				"claimedAt" = null,
				"lastError" = ${reason.slice(0, 2000)},
				"runAfter" = ${runAfter},
				"failedAt" = ${exhausted ? at : null}
			where "id" = ${id} and "claimId" = ${claimId}
		`.execute(db)
		return Number(result.numAffectedRows ?? 0) > 0
	},

	listPending: async (kind: string): Promise<JobRow[]> =>
		db
			.selectFrom("job")
			.selectAll()
			.where("kind", "=", kind)
			.where("completedAt", "is", null)
			.where("failedAt", "is", null)
			.orderBy("runAfter", "asc")
			.execute(),
})

export type JobRepository = ReturnType<typeof createJobRepository>

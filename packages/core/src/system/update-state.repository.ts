import type { UpdateCheckOutcome, UpdateSource } from "@open-mcc/contracts"
import type { Executor, UpdateStateRow } from "@open-mcc/db"

export const UPDATE_STATE_ID = "singleton"

export type LatestRelease = {
	readonly version: string
	readonly notes: string | null
	readonly notesTruncated: boolean
}

export type UpdateCheckResult =
	| { readonly outcome: Extract<UpdateCheckOutcome, "ok">; readonly release: LatestRelease }
	| { readonly outcome: Extract<UpdateCheckOutcome, "rate-limited">; readonly until: Date | null }
	| { readonly outcome: Exclude<UpdateCheckOutcome, "ok" | "rate-limited"> }

const columnsFor = (checkedAt: Date, result: UpdateCheckResult) => {
	const check = {
		checkedAt,
		checkOutcome: result.outcome,
		rateLimitedUntil: result.outcome === "rate-limited" ? result.until : null,
	}
	if (result.outcome !== "ok") return check
	return {
		...check,
		latestVersion: result.release.version,
		latestNotes: result.release.notes,
		notesTruncated: result.release.notesTruncated,
	}
}

export const createUpdateStateRepository = (db: Executor) => ({
	find: async (): Promise<UpdateStateRow | undefined> =>
		await db
			.selectFrom("updateState")
			.selectAll()
			.where("id", "=", UPDATE_STATE_ID)
			.executeTakeFirst(),

	recordCheck: async (
		source: UpdateSource,
		checkedAt: Date,
		result: UpdateCheckResult,
	): Promise<void> => {
		const columns = columnsFor(checkedAt, result)
		await db
			.insertInto("updateState")
			.values({
				id: UPDATE_STATE_ID,
				sourceOwner: source.owner,
				sourceRepo: source.repo,
				...columns,
			})
			.onConflict((conflict) => conflict.column("id").doUpdateSet(columns))
			.execute()
	},
})

export type UpdateStateRepository = ReturnType<typeof createUpdateStateRepository>

import type { Executor } from "@open-mcc/db"

export const createOrganizationRepository = (db: Executor) => ({
	listIds: async (): Promise<string[]> =>
		(await db.selectFrom("organization").select("id").orderBy("id", "asc").execute()).map(
			(row) => row.id,
		),
})

export type OrganizationRepository = ReturnType<typeof createOrganizationRepository>

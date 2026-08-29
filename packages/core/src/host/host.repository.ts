import { type Db, type HostInsert, type HostRow, host } from "@open-mcc/db"
import { and, eq } from "drizzle-orm"

export type OrgScope = { organizationId: string }

export type HostCreateValues = Omit<HostInsert, "id" | "organizationId" | "createdAt">

export const createHostRepository = (db: Db) => ({
	insert: async (scope: OrgScope, values: HostCreateValues): Promise<HostRow> => {
		const rows = await db
			.insert(host)
			.values({ ...values, organizationId: scope.organizationId })
			.returning()
		const row = rows[0]
		if (!row) throw new Error("Host insert returned no row")
		return row
	},

	findById: async (scope: OrgScope, id: string): Promise<HostRow | undefined> => {
		const rows = await db
			.select()
			.from(host)
			.where(and(eq(host.id, id), eq(host.organizationId, scope.organizationId)))
			.limit(1)
		return rows[0]
	},

	list: async (scope: OrgScope): Promise<HostRow[]> =>
		db.select().from(host).where(eq(host.organizationId, scope.organizationId)),

	update: async (
		scope: OrgScope,
		id: string,
		patch: Partial<HostCreateValues> & Partial<Pick<HostRow, "status">>,
	): Promise<HostRow | undefined> => {
		const rows = await db
			.update(host)
			.set(patch)
			.where(and(eq(host.id, id), eq(host.organizationId, scope.organizationId)))
			.returning()
		return rows[0]
	},

	delete: async (scope: OrgScope, id: string): Promise<boolean> => {
		const rows = await db
			.delete(host)
			.where(and(eq(host.id, id), eq(host.organizationId, scope.organizationId)))
			.returning()
		return rows.length > 0
	},
})

export type HostRepository = ReturnType<typeof createHostRepository>

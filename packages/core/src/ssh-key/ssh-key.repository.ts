import { type Db, type SshKeyInsert, type SshKeyRow, sshKey } from "@open-mcc/db"
import { and, eq } from "drizzle-orm"
import type { OrgScope } from "../host/host.repository"

export type SshKeyCreateValues = Omit<SshKeyInsert, "id" | "organizationId" | "createdAt">

export const createSshKeyRepository = (db: Db) => ({
	insert: async (scope: OrgScope, values: SshKeyCreateValues): Promise<SshKeyRow> => {
		const rows = await db
			.insert(sshKey)
			.values({ ...values, organizationId: scope.organizationId })
			.returning()
		const row = rows[0]
		if (!row) throw new Error("SSH key insert returned no row")
		return row
	},

	findById: async (scope: OrgScope, id: string): Promise<SshKeyRow | undefined> => {
		const rows = await db
			.select()
			.from(sshKey)
			.where(and(eq(sshKey.id, id), eq(sshKey.organizationId, scope.organizationId)))
			.limit(1)
		return rows[0]
	},

	list: async (scope: OrgScope): Promise<SshKeyRow[]> =>
		db.select().from(sshKey).where(eq(sshKey.organizationId, scope.organizationId)),

	delete: async (scope: OrgScope, id: string): Promise<boolean> => {
		const rows = await db
			.delete(sshKey)
			.where(and(eq(sshKey.id, id), eq(sshKey.organizationId, scope.organizationId)))
			.returning()
		return rows.length > 0
	},
})

export type SshKeyRepository = ReturnType<typeof createSshKeyRepository>

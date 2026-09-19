import type { Executor, SshKeyInsert, SshKeyRow } from "@open-mcc/db"
import { nanoid } from "nanoid"
import type { OrgScope } from "../host/host.repository"
import { InternalError } from "../lib/errors"

export type SshKeyCreateValues = Omit<SshKeyInsert, "id" | "organizationId" | "createdAt">

export const createSshKeyRepository = (db: Executor) => ({
	insert: async (scope: OrgScope, values: SshKeyCreateValues): Promise<SshKeyRow> => {
		const row = await db
			.insertInto("sshKey")
			.values({ ...values, id: nanoid(), organizationId: scope.organizationId })
			.returningAll()
			.executeTakeFirst()
		if (!row) throw new InternalError("SSH key insert returned no row")
		return row
	},

	findById: async (scope: OrgScope, id: string): Promise<SshKeyRow | undefined> =>
		db
			.selectFrom("sshKey")
			.selectAll()
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.limit(1)
			.executeTakeFirst(),

	list: async (scope: OrgScope): Promise<SshKeyRow[]> =>
		db
			.selectFrom("sshKey")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.execute(),

	delete: async (scope: OrgScope, id: string): Promise<boolean> => {
		const rows = await db
			.deleteFrom("sshKey")
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.returningAll()
			.execute()
		return rows.length > 0
	},
})

export type SshKeyRepository = ReturnType<typeof createSshKeyRepository>

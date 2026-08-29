import { type AuditEventRow, auditEvent, type Executor } from "@open-mcc/db"
import { desc, eq } from "drizzle-orm"
import type { OrgScope } from "../host/host.repository"

export type AuditEntry = {
	actorId: string | null
	action: string
	subjectType: string
	subjectId: string
	detail: Record<string, string>
}

export const createAuditRepository = (db: Executor) => ({
	record: async (scope: OrgScope, entry: AuditEntry): Promise<AuditEventRow> => {
		const rows = await db
			.insert(auditEvent)
			.values({
				...entry,
				organizationId: scope.organizationId,
				actorLabel: entry.actorId ?? "system",
			})
			.returning()
		const row = rows[0]
		if (!row) throw new Error("Audit insert returned no row")
		return row
	},

	list: async (scope: OrgScope, limit = 100): Promise<AuditEventRow[]> =>
		db
			.select()
			.from(auditEvent)
			.where(eq(auditEvent.organizationId, scope.organizationId))
			.orderBy(desc(auditEvent.createdAt))
			.limit(limit),
})

export type AuditRepository = ReturnType<typeof createAuditRepository>

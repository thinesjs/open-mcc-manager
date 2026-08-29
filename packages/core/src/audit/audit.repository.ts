import { type AuditEventRow, auditEvent, type Executor } from "@open-mcc/db"
import { desc, eq } from "drizzle-orm"
import type { OrgScope } from "../host/host.repository"

export type AuditEntry = {
	actorId: string | null
	actorLabel: string
	action: string
	subjectType: string
	subjectId: string
	detail: Record<string, string>
}

const SYSTEM_ACTOR_LABEL = "system"

const resolveActorLabel = (entry: Pick<AuditEntry, "actorId" | "actorLabel">): string => {
	if (entry.actorId === null) {
		return entry.actorLabel.trim().length > 0 ? entry.actorLabel : SYSTEM_ACTOR_LABEL
	}
	if (entry.actorLabel.trim().length === 0) {
		throw new Error("actorLabel is required when actorId is set")
	}
	return entry.actorLabel
}

export const createAuditRepository = (db: Executor) => ({
	record: async (scope: OrgScope, entry: AuditEntry): Promise<AuditEventRow> => {
		const rows = await db
			.insert(auditEvent)
			.values({
				...entry,
				organizationId: scope.organizationId,
				actorLabel: resolveActorLabel(entry),
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

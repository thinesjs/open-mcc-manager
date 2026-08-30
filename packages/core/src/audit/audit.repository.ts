import type { AuditEventRow, Executor } from "@open-mcc/db"
import { nanoid } from "nanoid"
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
		const row = await db
			.insertInto("auditEvent")
			.values({
				...entry,
				id: nanoid(),
				organizationId: scope.organizationId,
				actorLabel: resolveActorLabel(entry),
			})
			.returningAll()
			.executeTakeFirst()
		if (!row) throw new Error("Audit insert returned no row")
		return row
	},

	list: async (scope: OrgScope, limit = 100): Promise<AuditEventRow[]> =>
		db
			.selectFrom("auditEvent")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.orderBy("createdAt", "desc")
			.limit(limit)
			.execute(),
})

export type AuditRepository = ReturnType<typeof createAuditRepository>

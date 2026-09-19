import type { AuditAction } from "@open-mcc/contracts"
import type { AuditEventRow, Executor } from "@open-mcc/db"
import { nanoid } from "nanoid"
import type { OrgScope } from "../host/host.repository"
import { InternalError } from "../lib/errors"

export type AuditEntry = {
	actorId: string | null
	actorLabel: string
	action: AuditAction
	subjectType: string
	subjectId: string
	detail: Record<string, string>
}

export type AuditPageRequest = {
	limit: number
	offset: number
}

const SYSTEM_ACTOR_LABEL = "system"

const resolveActorLabel = (entry: Pick<AuditEntry, "actorId" | "actorLabel">): string => {
	if (entry.actorId === null) {
		return entry.actorLabel.trim().length > 0 ? entry.actorLabel : SYSTEM_ACTOR_LABEL
	}
	if (entry.actorLabel.trim().length === 0) {
		throw new InternalError("actorLabel is required when actorId is set")
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
		if (!row) throw new InternalError("Audit insert returned no row")
		return row
	},

	list: async (scope: OrgScope, page: AuditPageRequest): Promise<AuditEventRow[]> =>
		db
			.selectFrom("auditEvent")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.orderBy("createdAt", "desc")
			.orderBy("id", "desc")
			.limit(page.limit)
			.offset(page.offset)
			.execute(),

	count: async (scope: OrgScope): Promise<number> => {
		const rows = await db
			.selectFrom("auditEvent")
			.select(({ fn }) => fn.countAll<string>().as("total"))
			.where("organizationId", "=", scope.organizationId)
			.execute()
		return Number(rows[0]?.total ?? "0")
	},
})

export type AuditRepository = ReturnType<typeof createAuditRepository>

import type { Insertable, Selectable } from "kysely"
import type { DB, Generated } from "../generated/database"

export type AuditEventTable = Omit<DB["auditEvent"], "actorId" | "detail"> & {
	actorId: Generated<DB["auditEvent"]["actorId"]>
	detail: Generated<Record<string, string>>
}

export type AuditEventRow = Selectable<AuditEventTable>
export type AuditEventInsert = Insertable<AuditEventTable>

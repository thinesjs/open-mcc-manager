import type { Insertable, Selectable, SelectType } from "kysely"
import type { DB, Generated } from "../generated/database"

type RefinementOf<Narrowed extends Base, Base> = Narrowed

type _AuditDetailRefinesGeneratedColumn = RefinementOf<
	Record<string, string>,
	SelectType<DB["auditEvent"]["detail"]>
>

export type AuditEventTable = Omit<DB["auditEvent"], "actorId" | "detail"> & {
	actorId: Generated<DB["auditEvent"]["actorId"]>
	detail: Generated<Record<string, string>>
}

export type AuditEventRow = Selectable<AuditEventTable>
export type AuditEventInsert = Insertable<AuditEventTable>

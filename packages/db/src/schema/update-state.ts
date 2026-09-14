import type { Insertable, Selectable, SelectType } from "kysely"
import type { DB } from "../generated/database"

type RefinementOf<Narrowed extends Base, Base> = Narrowed

export type UpdateCheckOutcome = "ok" | "unreachable" | "rate-limited" | "not-found" | "unreadable"

type _UpdateCheckOutcomeRefinesGeneratedColumn = RefinementOf<
	UpdateCheckOutcome,
	SelectType<DB["updateState"]["checkOutcome"]>
>

export type UpdateStateTable = Omit<DB["updateState"], "checkOutcome"> & {
	checkOutcome: UpdateCheckOutcome
}

export type UpdateStateRow = Selectable<UpdateStateTable>
export type UpdateStateInsert = Insertable<UpdateStateTable>

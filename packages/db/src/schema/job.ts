import type { ColumnType, Insertable, Selectable } from "kysely"
import type { DB, Generated } from "../generated/database"

type Optional<Select, Insert = Select> = ColumnType<
	Select | null,
	Insert | null | undefined,
	Insert | null
>

export type JobTable = Omit<
	DB["job"],
	"payload" | "runAfter" | "claimId" | "claimedAt" | "lastError" | "completedAt" | "failedAt"
> & {
	payload: Generated<Record<string, string>>
	runAfter: Generated<DB["job"]["runAfter"]>
	claimId: Optional<string>
	claimedAt: Optional<Date, Date | string>
	lastError: Optional<string>
	completedAt: Optional<Date, Date | string>
	failedAt: Optional<Date, Date | string>
}

export type JobRow = Selectable<JobTable>
export type JobInsert = Insertable<JobTable>

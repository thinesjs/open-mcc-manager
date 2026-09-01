import type { Insertable, Selectable, SelectType } from "kysely"
import type { DB, Generated } from "../generated/database"

type RefinementOf<Narrowed extends Base, Base> = Narrowed

export type InstanceStatus = "created" | "needs_auth" | "stopped" | "running" | "error"

type _InstanceStatusRefinesGeneratedColumn = RefinementOf<
	InstanceStatus,
	SelectType<DB["instance"]["status"]>
>

export type InstanceTable = Omit<
	DB["instance"],
	"status" | "lastExitCode" | "authClaimId" | "authClaimedAt"
> & {
	status: Generated<InstanceStatus>
	lastExitCode: Generated<DB["instance"]["lastExitCode"]>
	authClaimId: Generated<DB["instance"]["authClaimId"]>
	authClaimedAt: Generated<DB["instance"]["authClaimedAt"]>
}

export type InstanceRow = Selectable<InstanceTable>
export type InstanceInsert = Insertable<InstanceTable>

export type InstanceConfigTable = Omit<DB["instanceConfig"], "authorId"> & {
	authorId: Generated<DB["instanceConfig"]["authorId"]>
}

export type InstanceConfigRow = Selectable<InstanceConfigTable>
export type InstanceConfigInsert = Insertable<InstanceConfigTable>

export type InstanceScheduleTable = Omit<DB["instanceSchedule"], "enabled"> & {
	enabled: Generated<boolean>
}

export type InstanceScheduleRow = Selectable<InstanceScheduleTable>
export type InstanceScheduleInsert = Insertable<InstanceScheduleTable>

export type InstanceCommandTable = Omit<
	DB["instanceCommand"],
	"enabled" | "lastRunAt" | "lastRunError"
> & {
	enabled: Generated<boolean>
	lastRunAt: Generated<DB["instanceCommand"]["lastRunAt"]>
	lastRunError: Generated<DB["instanceCommand"]["lastRunError"]>
}

export type InstanceCommandRow = Selectable<InstanceCommandTable>
export type InstanceCommandInsert = Insertable<InstanceCommandTable>

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

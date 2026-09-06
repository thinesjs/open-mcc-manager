import type { Insertable, Selectable, SelectType } from "kysely"
import type { DB, Generated } from "../generated/database"

type RefinementOf<Narrowed extends Base, Base> = Narrowed

export type InstanceStatus = "created" | "needs_auth" | "stopped" | "running" | "error"

export type AccountType = "microsoft" | "offline"

type _InstanceStatusRefinesGeneratedColumn = RefinementOf<
	InstanceStatus,
	SelectType<DB["instance"]["status"]>
>

type _AccountTypeRefinesGeneratedColumn = RefinementOf<
	AccountType,
	SelectType<DB["instance"]["accountType"]>
>

export type InstanceTable = Omit<
	DB["instance"],
	| "status"
	| "accountType"
	| "lastExitCode"
	| "liveControlPort"
	| "liveControlTokenEncrypted"
	| "liveControlTokenKeyId"
	| "authClaimId"
	| "authClaimedAt"
	| "minecraftUsername"
> & {
	status: Generated<InstanceStatus>
	accountType: Generated<AccountType>
	lastExitCode: Generated<DB["instance"]["lastExitCode"]>
	liveControlPort: Generated<DB["instance"]["liveControlPort"]>
	liveControlTokenEncrypted: Generated<DB["instance"]["liveControlTokenEncrypted"]>
	liveControlTokenKeyId: Generated<DB["instance"]["liveControlTokenKeyId"]>
	authClaimId: Generated<DB["instance"]["authClaimId"]>
	authClaimedAt: Generated<DB["instance"]["authClaimedAt"]>
	minecraftUsername: Generated<DB["instance"]["minecraftUsername"]>
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

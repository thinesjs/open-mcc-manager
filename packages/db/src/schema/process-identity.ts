import type { Insertable, Selectable } from "kysely"
import type { DB, Generated } from "../generated/database"

export type ProcessRole = "server" | "worker"

export type ProcessIdentityTable = Omit<DB["processIdentity"], "role" | "startedAt" | "seenAt"> & {
	role: ProcessRole
	startedAt: Generated<DB["processIdentity"]["startedAt"]>
	seenAt: Generated<DB["processIdentity"]["seenAt"]>
}

export type ProcessIdentityRow = Selectable<ProcessIdentityTable>
export type ProcessIdentityInsert = Insertable<ProcessIdentityTable>

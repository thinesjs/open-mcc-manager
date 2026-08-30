import type { Insertable, Selectable } from "kysely"
import type { DB } from "../generated/database"

export type SshKeyTable = DB["sshKey"]

export type SshKeyRow = Selectable<SshKeyTable>
export type SshKeyInsert = Insertable<SshKeyTable>

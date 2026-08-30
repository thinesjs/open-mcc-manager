import type { DB } from "./generated/database"
import type { AuditEventTable } from "./schema/audit"
import type { HostTable } from "./schema/host"
import type { SshKeyTable } from "./schema/ssh-key"

export type Database = Omit<DB, "host" | "sshKey" | "auditEvent"> & {
	host: HostTable
	sshKey: SshKeyTable
	auditEvent: AuditEventTable
}

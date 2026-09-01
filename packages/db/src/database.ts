import type { DB } from "./generated/database"
import type { AuditEventTable } from "./schema/audit"
import type { HostTable } from "./schema/host"
import type { InstanceConfigTable, InstanceScheduleTable, InstanceTable } from "./schema/instance"
import type { SshKeyTable } from "./schema/ssh-key"

export type Database = Omit<
	DB,
	"host" | "sshKey" | "auditEvent" | "instance" | "instanceConfig" | "instanceSchedule"
> & {
	host: HostTable
	sshKey: SshKeyTable
	auditEvent: AuditEventTable
	instance: InstanceTable
	instanceConfig: InstanceConfigTable
	instanceSchedule: InstanceScheduleTable
}

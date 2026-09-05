import type { DB } from "./generated/database"
import type { AuditEventTable } from "./schema/audit"
import type { HostTable } from "./schema/host"
import type {
	InstanceCommandTable,
	InstanceConfigTable,
	InstanceScheduleTable,
	InstanceTable,
} from "./schema/instance"
import type { ProcessIdentityTable } from "./schema/process-identity"
import type { SshKeyTable } from "./schema/ssh-key"

export type Database = Omit<
	DB,
	| "host"
	| "sshKey"
	| "auditEvent"
	| "instance"
	| "instanceConfig"
	| "instanceSchedule"
	| "instanceCommand"
> & {
	host: HostTable
	processIdentity: ProcessIdentityTable
	sshKey: SshKeyTable
	auditEvent: AuditEventTable
	instance: InstanceTable
	instanceConfig: InstanceConfigTable
	instanceSchedule: InstanceScheduleTable
	instanceCommand: InstanceCommandTable
}

import type { DB } from "./generated/database"
import type { AuditEventTable } from "./schema/audit"
import type { HostTable } from "./schema/host"
import type {
	InstanceCommandTable,
	InstanceConfigTable,
	InstanceScheduleTable,
	InstanceTable,
} from "./schema/instance"
import type { InstanceArtifactTable } from "./schema/instance-artifact"
import type {
	InstanceSignalCursorTable,
	InstanceSignalTable,
	InstanceTaskRunTable,
	InstanceTaskStepTable,
	InstanceTaskTable,
	InstanceTaskTimeTable,
} from "./schema/instance-task"
import type {
	NotificationAttemptTable,
	NotificationDeliveryTable,
	NotificationDestinationTable,
	NotificationSubscriptionTable,
	NotificationTable,
} from "./schema/notification"
import type { ProcessIdentityTable } from "./schema/process-identity"
import type { SshKeyTable } from "./schema/ssh-key"
import type {
	StatusConditionTable,
	StatusDailyRollupTable,
	StatusEventTable,
	StatusIntervalTable,
	StatusSourceCursorTable,
} from "./schema/status"
import type { UpdateStateTable } from "./schema/update-state"

export type Database = Omit<
	DB,
	| "host"
	| "sshKey"
	| "auditEvent"
	| "instance"
	| "instanceArtifact"
	| "instanceConfig"
	| "instanceSchedule"
	| "instanceCommand"
	| "instanceTask"
	| "instanceTaskStep"
	| "instanceTaskTime"
	| "instanceTaskRun"
	| "instanceSignal"
	| "instanceSignalCursor"
	| "statusEvent"
	| "statusCondition"
	| "statusInterval"
	| "statusDailyRollup"
	| "statusSourceCursor"
	| "notification"
	| "notificationDestination"
	| "notificationDelivery"
	| "notificationAttempt"
	| "notificationSubscription"
	| "updateState"
> & {
	host: HostTable
	processIdentity: ProcessIdentityTable
	sshKey: SshKeyTable
	auditEvent: AuditEventTable
	instance: InstanceTable
	instanceArtifact: InstanceArtifactTable
	instanceConfig: InstanceConfigTable
	instanceSchedule: InstanceScheduleTable
	instanceCommand: InstanceCommandTable
	instanceTask: InstanceTaskTable
	instanceTaskStep: InstanceTaskStepTable
	instanceTaskTime: InstanceTaskTimeTable
	instanceTaskRun: InstanceTaskRunTable
	instanceSignal: InstanceSignalTable
	instanceSignalCursor: InstanceSignalCursorTable
	statusEvent: StatusEventTable
	statusCondition: StatusConditionTable
	statusInterval: StatusIntervalTable
	statusDailyRollup: StatusDailyRollupTable
	statusSourceCursor: StatusSourceCursorTable
	notification: NotificationTable
	notificationDestination: NotificationDestinationTable
	notificationDelivery: NotificationDeliveryTable
	notificationAttempt: NotificationAttemptTable
	notificationSubscription: NotificationSubscriptionTable
	updateState: UpdateStateTable
}

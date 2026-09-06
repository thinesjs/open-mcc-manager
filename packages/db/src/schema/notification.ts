import type { Insertable, Selectable, SelectType } from "kysely"
import type { DB, Generated } from "../generated/database"

type RefinementOf<Narrowed extends Base, Base> = Narrowed

export type DestinationKind = "webhook" | "telegram"

type _KindRefines = RefinementOf<DestinationKind, SelectType<DB["notificationDestination"]["kind"]>>

export type DeliveryState = "queued" | "delivered" | "failed" | "abandoned"

export type AttemptOutcome = "delivered" | "retryable" | "terminal"

export type NotificationDestinationTable = Omit<
	DB["notificationDestination"],
	"kind" | "enabled" | "createdAt" | "lastSucceededAt" | "lastFailedAt" | "lastFailureReason"
> & {
	kind: DestinationKind
	enabled: Generated<boolean>
	createdAt: Generated<Date>
	lastSucceededAt: Generated<Date | null>
	lastFailedAt: Generated<Date | null>
	lastFailureReason: Generated<string | null>
}

export type NotificationDestinationRow = Selectable<NotificationDestinationTable>
export type NotificationDestinationInsert = Insertable<NotificationDestinationTable>

export type NotificationTable = Omit<DB["notification"], "createdAt"> & {
	createdAt: Generated<Date>
}

export type NotificationRow = Selectable<NotificationTable>
export type NotificationInsert = Insertable<NotificationTable>

export type NotificationDeliveryTable = Omit<
	DB["notificationDelivery"],
	"state" | "attempts" | "createdAt" | "settledAt" | "lastError"
> & {
	state: DeliveryState
	attempts: Generated<number>
	createdAt: Generated<Date>
	settledAt: Generated<Date | null>
	lastError: Generated<string | null>
}

export type NotificationDeliveryRow = Selectable<NotificationDeliveryTable>
export type NotificationDeliveryInsert = Insertable<NotificationDeliveryTable>

export type NotificationAttemptTable = Omit<DB["notificationAttempt"], "outcome" | "at"> & {
	outcome: AttemptOutcome
	at: Generated<Date>
}

export type NotificationAttemptRow = Selectable<NotificationAttemptTable>
export type NotificationAttemptInsert = Insertable<NotificationAttemptTable>

export type NotificationSubscriptionRow = Selectable<DB["notificationSubscription"]>
export type NotificationSubscriptionInsert = Insertable<DB["notificationSubscription"]>

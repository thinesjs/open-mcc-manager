import type { Insertable, Selectable, SelectType } from "kysely"
import type { DB, Generated } from "../generated/database"

type RefinementOf<Narrowed extends Base, Base> = Narrowed

export type DestinationKind =
	| "webhook"
	| "telegram"
	| "discord"
	| "slack"
	| "teams"
	| "email"
	| "resend"
	| "gotify"
	| "ntfy"

type _KindRefines = RefinementOf<DestinationKind, SelectType<DB["notificationDestination"]["kind"]>>

export type SubscriptionKind =
	| "host.unreachable"
	| "host.drift_started"
	| "instance.disconnected"
	| "instance.flapping"
	| "instance.never_joined"
	| "instance.unexpected_stop"
	| "instance.needs_auth"
	| "instance.drift_started"

type _SubscriptionKindRefines = RefinementOf<
	SubscriptionKind,
	SelectType<DB["notificationSubscription"]["kind"]>
>

export type NotificationKind =
	| SubscriptionKind
	| "host.recovered"
	| "host.drift_resolved"
	| "instance.reconnected"
	| "instance.process_recovered"
	| "instance.drift_resolved"
	| "test"

type _NotificationKindRefines = RefinementOf<
	NotificationKind,
	SelectType<DB["notification"]["kind"]>
>

export type NotificationSubjectType = "host" | "instance"

type _NotificationSubjectTypeRefines = RefinementOf<
	NotificationSubjectType,
	SelectType<DB["notification"]["subjectType"]>
>

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

export type NotificationTable = Omit<DB["notification"], "kind" | "subjectType" | "createdAt"> & {
	kind: NotificationKind
	subjectType: NotificationSubjectType
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

export type NotificationSubscriptionTable = Omit<DB["notificationSubscription"], "kind"> & {
	kind: SubscriptionKind
}

export type NotificationSubscriptionRow = Selectable<NotificationSubscriptionTable>
export type NotificationSubscriptionInsert = Insertable<NotificationSubscriptionTable>

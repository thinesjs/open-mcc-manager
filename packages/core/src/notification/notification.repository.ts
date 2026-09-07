import type {
	AttemptOutcome,
	DeliveryState,
	Executor,
	NotificationDeliveryRow,
	NotificationDestinationRow,
	NotificationInsert,
	NotificationKind,
	NotificationRow,
	SubscriptionKind,
} from "@open-mcc/db"
import { nanoid } from "nanoid"
import type { OrgScope } from "../host/host.repository"

export type PlannedDelivery = { deliveryId: string; destinationId: string }

export const createNotificationRepository = (db: Executor) => ({
	destinationsSubscribedTo: async (
		scope: OrgScope,
		kind: SubscriptionKind,
	): Promise<NotificationDestinationRow[]> =>
		await db
			.selectFrom("notificationDestination")
			.selectAll("notificationDestination")
			.innerJoin("notificationSubscription", (join) =>
				join
					.onRef("notificationSubscription.destinationId", "=", "notificationDestination.id")
					.onRef(
						"notificationSubscription.organizationId",
						"=",
						"notificationDestination.organizationId",
					),
			)
			.where("notificationDestination.organizationId", "=", scope.organizationId)
			.where("notificationDestination.enabled", "=", true)
			.where("notificationSubscription.kind", "=", kind)
			.execute(),

	findDestination: async (
		scope: OrgScope,
		destinationId: string,
	): Promise<NotificationDestinationRow | undefined> =>
		await db
			.selectFrom("notificationDestination")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", destinationId)
			.executeTakeFirst(),

	lastAnnouncedAmong: async (
		scope: OrgScope,
		subjectType: "host" | "instance",
		subjectId: string,
		kinds: readonly NotificationKind[],
	): Promise<NotificationRow | undefined> =>
		kinds.length === 0
			? undefined
			: await db
					.selectFrom("notification")
					.selectAll()
					.where("organizationId", "=", scope.organizationId)
					.where("subjectType", "=", subjectType)
					.where("subjectId", "=", subjectId)
					.where("kind", "in", kinds)
					.orderBy("createdAt", "desc")
					.orderBy("id", "desc")
					.executeTakeFirst(),

	notifiedAlready: async (
		scope: OrgScope,
		dedupeKey: string,
	): Promise<NotificationRow | undefined> =>
		await db
			.selectFrom("notification")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.where("dedupeKey", "=", dedupeKey)
			.executeTakeFirst(),

	createNotification: async (
		scope: OrgScope,
		values: Omit<NotificationInsert, "id" | "organizationId">,
	): Promise<NotificationRow | undefined> =>
		await db
			.insertInto("notification")
			.values({ ...values, id: nanoid(), organizationId: scope.organizationId })
			.onConflict((conflict) => conflict.columns(["organizationId", "dedupeKey"]).doNothing())
			.returningAll()
			.executeTakeFirst(),

	findDelivery: async (
		scope: OrgScope,
		deliveryId: string,
	): Promise<NotificationDeliveryRow | undefined> =>
		await db
			.selectFrom("notificationDelivery")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", deliveryId)
			.executeTakeFirst(),

	findNotification: async (
		scope: OrgScope,
		notificationId: string,
	): Promise<NotificationRow | undefined> =>
		await db
			.selectFrom("notification")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", notificationId)
			.executeTakeFirst(),

	recordAttempt: async (
		scope: OrgScope,
		values: {
			deliveryId: string
			attempt: number
			outcome: AttemptOutcome
			statusCode: number | null
			error: string | null
		},
	): Promise<void> => {
		await db
			.insertInto("notificationAttempt")
			.values({ ...values, id: nanoid(), organizationId: scope.organizationId })
			.execute()
	},

	settleDelivery: async (
		scope: OrgScope,
		deliveryId: string,
		values: {
			state: DeliveryState
			attempts: number
			settledAt: Date | null
			lastError: string | null
		},
	): Promise<void> => {
		await db
			.updateTable("notificationDelivery")
			.set(values)
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", deliveryId)
			.execute()
	},

	markDestinationOutcome: async (
		scope: OrgScope,
		destinationId: string,
		values: { succeededAt: Date | null; failedAt: Date | null; reason: string | null },
	): Promise<void> => {
		await db
			.updateTable("notificationDestination")
			.set(
				values.succeededAt === null
					? { lastFailedAt: values.failedAt, lastFailureReason: values.reason }
					: { lastSucceededAt: values.succeededAt, lastFailureReason: null },
			)
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", destinationId)
			.execute()
	},

	disableDestination: async (scope: OrgScope, destinationId: string): Promise<void> => {
		await db
			.updateTable("notificationDestination")
			.set({ enabled: false })
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", destinationId)
			.execute()
	},

	createDelivery: async (
		scope: OrgScope,
		values: { notificationId: string; destinationId: string },
	): Promise<NotificationDeliveryRow | undefined> =>
		await db
			.insertInto("notificationDelivery")
			.values({
				...values,
				id: nanoid(),
				organizationId: scope.organizationId,
				state: "queued",
			})
			.onConflict((conflict) =>
				conflict.columns(["organizationId", "notificationId", "destinationId"]).doNothing(),
			)
			.returningAll()
			.executeTakeFirst(),
})

export type NotificationRepository = ReturnType<typeof createNotificationRepository>

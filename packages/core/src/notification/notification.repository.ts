import type { DeliveryFailureView } from "@open-mcc/contracts"
import type {
	AttemptOutcome,
	DeliveryState,
	DestinationKind,
	Executor,
	NotificationDeliveryRow,
	NotificationDestinationRow,
	NotificationInsert,
	NotificationKind,
	NotificationRow,
	SubscriptionKind,
} from "@open-mcc/db"
import { sql } from "kysely"
import { nanoid } from "nanoid"
import type { OrgScope } from "../host/host.repository"

export type PlannedDelivery = { deliveryId: string; destinationId: string }

export type RetentionBoundaries = {
	readonly createdBefore: Date
	readonly settledBefore: Date
}

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

	listDestinations: async (scope: OrgScope): Promise<NotificationDestinationRow[]> =>
		await db
			.selectFrom("notificationDestination")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.orderBy("name", "asc")
			.execute(),

	subscriptionsFor: async (
		scope: OrgScope,
		destinationIds: readonly string[],
	): Promise<{ destinationId: string; kind: SubscriptionKind }[]> =>
		destinationIds.length === 0
			? []
			: await db
					.selectFrom("notificationSubscription")
					.select(["destinationId", "kind"])
					.where("organizationId", "=", scope.organizationId)
					.where("destinationId", "in", destinationIds)
					.execute(),

	insertDestination: async (
		scope: OrgScope,
		values: {
			name: string
			kind: DestinationKind
			displayTarget: string
			secretEncrypted: string
			secretKeyId: string
		},
	): Promise<NotificationDestinationRow> => {
		const row = await db
			.insertInto("notificationDestination")
			.values({ ...values, id: nanoid(), organizationId: scope.organizationId })
			.returningAll()
			.executeTakeFirst()
		if (!row) throw new Error("the destination could not be saved")
		return row
	},

	updateDestination: async (
		scope: OrgScope,
		destinationId: string,
		values: {
			name: string
			displayTarget: string
			secretEncrypted: string
			secretKeyId: string
		},
	): Promise<NotificationDestinationRow | undefined> =>
		await db
			.updateTable("notificationDestination")
			.set(values)
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", destinationId)
			.returningAll()
			.executeTakeFirst(),

	setDestinationEnabled: async (
		scope: OrgScope,
		destinationId: string,
		enabled: boolean,
	): Promise<boolean> => {
		const result = await db
			.updateTable("notificationDestination")
			.set({ enabled })
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", destinationId)
			.executeTakeFirst()
		return result.numUpdatedRows === 1n
	},

	deleteDestination: async (scope: OrgScope, destinationId: string): Promise<boolean> => {
		const result = await db
			.deleteFrom("notificationDestination")
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", destinationId)
			.executeTakeFirst()
		return result.numDeletedRows === 1n
	},

	replaceSubscriptions: async (
		scope: OrgScope,
		destinationId: string,
		kinds: readonly SubscriptionKind[],
	): Promise<void> => {
		await db
			.deleteFrom("notificationSubscription")
			.where("organizationId", "=", scope.organizationId)
			.where("destinationId", "=", destinationId)
			.execute()
		if (kinds.length === 0) return
		await db
			.insertInto("notificationSubscription")
			.values(
				kinds.map((kind) => ({
					id: nanoid(),
					organizationId: scope.organizationId,
					destinationId,
					kind,
				})),
			)
			.execute()
	},

	abandonQueuedFor: async (
		scope: OrgScope,
		destinationId: string,
		at: Date,
		reason: string,
	): Promise<number> => {
		const result = await db
			.updateTable("notificationDelivery")
			.set({ state: "abandoned", settledAt: at, lastError: reason })
			.where("organizationId", "=", scope.organizationId)
			.where("destinationId", "=", destinationId)
			.where("state", "=", "queued")
			.executeTakeFirst()
		return Number(result.numUpdatedRows)
	},

	lockTestsFor: async (scope: OrgScope): Promise<void> => {
		await sql`select pg_advisory_xact_lock(hashtext(${scope.organizationId} || ':notification.test'))`.execute(
			db,
		)
	},

	testsSince: async (
		scope: OrgScope,
		destinationId: string | undefined,
		since: Date,
	): Promise<number> => {
		const rows = await db
			.selectFrom("notificationDelivery")
			.innerJoin("notification", (join) =>
				join
					.onRef("notification.id", "=", "notificationDelivery.notificationId")
					.onRef("notification.organizationId", "=", "notificationDelivery.organizationId"),
			)
			.select(({ fn }) => fn.countAll<string>().as("total"))
			.where("notificationDelivery.organizationId", "=", scope.organizationId)
			.$if(destinationId !== undefined, (builder) =>
				builder.where("notificationDelivery.destinationId", "=", destinationId ?? ""),
			)
			.where("notification.kind", "=", "test")
			.where("notificationDelivery.createdAt", ">=", since)
			.execute()
		return Number(rows[0]?.total ?? "0")
	},

	recentFailures: async (scope: OrgScope, limit: number): Promise<DeliveryFailureView[]> =>
		await db
			.selectFrom("notificationDelivery")
			.innerJoin("notification", (join) =>
				join
					.onRef("notification.id", "=", "notificationDelivery.notificationId")
					.onRef("notification.organizationId", "=", "notificationDelivery.organizationId"),
			)
			.innerJoin("notificationDestination", (join) =>
				join
					.onRef("notificationDestination.id", "=", "notificationDelivery.destinationId")
					.onRef(
						"notificationDestination.organizationId",
						"=",
						"notificationDelivery.organizationId",
					),
			)
			.select([
				"notificationDelivery.id as deliveryId",
				"notificationDelivery.destinationId as destinationId",
				"notificationDestination.name as destinationName",
				"notification.title as title",
				"notificationDelivery.lastError as reason",
				"notificationDelivery.attempts as attempts",
				"notificationDelivery.settledAt as settledAt",
			])
			.where("notificationDelivery.organizationId", "=", scope.organizationId)
			.where("notificationDelivery.state", "=", "failed")
			.orderBy("notificationDelivery.settledAt", "desc")
			.limit(limit)
			.execute(),

	requeueDelivery: async (scope: OrgScope, deliveryId: string): Promise<boolean> => {
		const result = await db
			.updateTable("notificationDelivery")
			.set({ state: "queued", attempts: 0, settledAt: null, lastError: null })
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", deliveryId)
			.where("state", "in", ["failed", "abandoned"])
			.executeTakeFirst()
		return result.numUpdatedRows === 1n
	},

	dismissDelivery: async (scope: OrgScope, deliveryId: string, at: Date): Promise<boolean> => {
		const result = await db
			.updateTable("notificationDelivery")
			.set({ state: "abandoned", settledAt: at })
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", deliveryId)
			.where("state", "=", "failed")
			.executeTakeFirst()
		return result.numUpdatedRows === 1n
	},

	deleteSettledBefore: async (
		scope: OrgScope,
		boundaries: RetentionBoundaries,
	): Promise<number> => {
		const result = await db
			.deleteFrom("notification")
			.where("organizationId", "=", scope.organizationId)
			.where("createdAt", "<", boundaries.createdBefore)
			.where(({ not, exists, selectFrom }) =>
				not(
					exists(
						selectFrom("notificationDelivery")
							.select("notificationDelivery.id")
							.whereRef("notificationDelivery.notificationId", "=", "notification.id")
							.whereRef("notificationDelivery.organizationId", "=", "notification.organizationId")
							.where((eb) =>
								eb.or([
									eb("notificationDelivery.state", "=", "queued"),
									eb("notificationDelivery.settledAt", "is", null),
									eb("notificationDelivery.settledAt", ">=", boundaries.settledBefore),
								]),
							),
					),
				),
			)
			.executeTakeFirst()
		return Number(result.numDeletedRows)
	},

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
		incidentId?: string,
	): Promise<NotificationRow | undefined> => {
		if (kinds.length === 0) return undefined
		let query = db
			.selectFrom("notification")
			.innerJoin("statusEvent", (join) =>
				join
					.onRef("statusEvent.id", "=", "notification.sourceStatusEventId")
					.onRef("statusEvent.organizationId", "=", "notification.organizationId"),
			)
			.selectAll("notification")
			.where("notification.organizationId", "=", scope.organizationId)
			.where("notification.subjectType", "=", subjectType)
			.where("notification.subjectId", "=", subjectId)
			.where("notification.kind", "in", kinds)
		if (incidentId !== undefined) {
			query = query.where("statusEvent.incidentId", "=", incidentId)
		}
		return await query
			.orderBy("notification.createdAt", "desc")
			.orderBy("notification.id", "desc")
			.executeTakeFirst()
	},

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
		const observedAt = values.succeededAt ?? values.failedAt
		if (!observedAt) return
		await db
			.updateTable("notificationDestination")
			.set(
				values.succeededAt === null
					? { lastFailedAt: values.failedAt, lastFailureReason: values.reason }
					: { lastSucceededAt: values.succeededAt, lastFailureReason: null },
			)
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", destinationId)
			.where(
				sql<Date>`greatest(coalesce("lastSucceededAt", '-infinity'), coalesce("lastFailedAt", '-infinity'))`,
				"<",
				observedAt,
			)
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

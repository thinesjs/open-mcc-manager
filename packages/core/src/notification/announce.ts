import { SUBSCRIPTION_KINDS, usesEmailTransport } from "@open-mcc/contracts"
import type { NotificationDestinationRow } from "@open-mcc/db"
import type { SqlRunner } from "../job/executor-adapter"
import type { QueueName, SendJob } from "../job/job.queue"
import { NOTIFICATION_EMAIL_QUEUE, NOTIFICATION_HTTP_QUEUE } from "../job/queue-setup"
import type { NotificationRepository } from "./notification.repository"
import type { EventFact, PlannedNotification } from "./producer"
import { planNotification, subscriptionKindFor } from "./producer"

export type AnnounceScope = { organizationId: string }

export type AnnounceDeps = {
	readonly notifications: NotificationRepository
	readonly sendJob: SendJob
	readonly runner: SqlRunner
}

export const queueFor = (destination: NotificationDestinationRow): QueueName =>
	usesEmailTransport(destination.kind) ? NOTIFICATION_EMAIL_QUEUE : NOTIFICATION_HTTP_QUEUE

export const announce = async (
	scope: AnnounceScope,
	fact: EventFact,
	deps: AnnounceDeps,
): Promise<PlannedNotification | undefined> => {
	const planned = await planNotification(fact, async (subjectType, subjectId, kinds) => {
		const last = await deps.notifications.lastAnnouncedAmong(scope, subjectType, subjectId, kinds)
		return last?.kind
	})
	if (!planned) return undefined

	const subscribable = SUBSCRIPTION_KINDS.find(
		(candidate) => candidate === subscriptionKindFor(fact.kind),
	)
	if (subscribable === undefined) return undefined

	const destinations = await deps.notifications.destinationsSubscribedTo(scope, subscribable)
	if (destinations.length === 0) return undefined

	const notification = await deps.notifications.createNotification(scope, {
		kind: planned.kind,
		title: planned.title,
		body: planned.body,
		subjectType: planned.subjectType,
		subjectId: planned.subjectId,
		dedupeKey: planned.dedupeKey,
		sourceStatusEventId: planned.sourceStatusEventId,
	})
	if (!notification) return undefined

	for (const destination of destinations) {
		const delivery = await deps.notifications.createDelivery(scope, {
			notificationId: notification.id,
			destinationId: destination.id,
		})
		if (!delivery) continue

		const jobId = await deps.sendJob(
			queueFor(destination),
			{ organizationId: scope.organizationId, deliveryId: delivery.id, attempt: "1" },
			deps.runner,
		)
		if (jobId === null) {
			throw new Error(`the delivery to ${destination.name} could not be queued`)
		}
	}

	return planned
}

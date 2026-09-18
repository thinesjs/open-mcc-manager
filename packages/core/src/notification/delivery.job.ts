import { DELIVERY_RETRY_LIMIT } from "@open-mcc/contracts"
import type { Json, NotificationDestinationRow } from "@open-mcc/db"
import type { SqlRunner } from "../job/executor-adapter"
import type { QueueName, SendJob } from "../job/job.queue"
import { NOTIFICATION_DEADLETTER_QUEUE } from "../job/queue-setup"
import { InternalError } from "../lib/errors"
import type { RuntimeErrorReporter } from "../log/reporters"
import { redact } from "../security/redact"
import type { EgressPolicy } from "./egress"
import type { NotificationRepository } from "./notification.repository"
import type { DeliveryOutcome } from "./outcome"
import { classifyRefusal } from "./outcome"
import type { NotificationEnvelope } from "./sender"

export const BASE_RETRY_SECONDS = 15

export const MAX_RETRY_SECONDS = 60 * 60

export const backoffSeconds = (attempt: number): number =>
	Math.min(MAX_RETRY_SECONDS, BASE_RETRY_SECONDS * 2 ** Math.max(0, attempt - 1))

export const nextDelaySeconds = (attempt: number, askedFor: number | undefined): number =>
	Math.min(MAX_RETRY_SECONDS, Math.max(askedFor ?? 0, backoffSeconds(attempt)))

export type DeliveryPayload = {
	organizationId: string
	deliveryId: string
	attempt: number
	traceparent?: string
}

export const readDeliveryPayload = (payload: object): DeliveryPayload | undefined => {
	if (payload === null || Array.isArray(payload)) return undefined
	const record: Record<string, Json | undefined> = { ...payload }
	const organizationId = record.organizationId
	const deliveryId = record.deliveryId
	const attempt = record.attempt
	if (typeof organizationId !== "string" || organizationId.length === 0) return undefined
	if (typeof deliveryId !== "string" || deliveryId.length === 0) return undefined
	const traceparent = record.traceparent
	const carried = typeof traceparent === "string" && traceparent.length > 0 ? { traceparent } : {}
	if (attempt === undefined) return { organizationId, deliveryId, attempt: 1, ...carried }
	const counted = typeof attempt === "string" ? Number(attempt) : attempt
	if (typeof counted !== "number" || !Number.isInteger(counted) || counted < 1) return undefined
	return { organizationId, deliveryId, attempt: counted, ...carried }
}

export type DeliverySend = (
	destination: NotificationDestinationRow,
	envelope: NotificationEnvelope,
	policy: EgressPolicy,
) => Promise<DeliveryOutcome>

export type DeliveryStore = Pick<
	NotificationRepository,
	| "findDelivery"
	| "findDestination"
	| "findNotification"
	| "recordAttempt"
	| "settleDelivery"
	| "markDestinationOutcome"
	| "disableDestination"
>

export type SettleTransaction = <T>(
	fn: (repos: { notifications: DeliveryStore; runner: SqlRunner }) => Promise<T>,
) => Promise<T>

export type DeliveryDeps = {
	readonly store: DeliveryStore
	readonly withTransaction: SettleTransaction
	readonly send: DeliverySend
	readonly sendJob: SendJob
	readonly queue: QueueName
	readonly policy: EgressPolicy
	readonly now: () => Date
	readonly retryLimit?: number
	readonly onError?: RuntimeErrorReporter
}

export type DeliveryResult = {
	settled: "delivered" | "failed" | "abandoned" | "skipped" | "retrying"
	afterSeconds?: number
}

const SETTLED = new Set(["delivered", "failed", "abandoned"])

const GAVE_UP = "the delivery did not go through"

export const createDeliveryHandler =
	(deps: DeliveryDeps) =>
	async (payload: DeliveryPayload): Promise<DeliveryResult> => {
		const scope = { organizationId: payload.organizationId }
		const retryLimit = deps.retryLimit ?? DELIVERY_RETRY_LIMIT
		const attempt = payload.attempt
		const carried = payload.traceparent === undefined ? {} : { traceparent: payload.traceparent }

		const delivery = await deps.store.findDelivery(scope, payload.deliveryId)
		if (!delivery || SETTLED.has(delivery.state)) return { settled: "skipped" }

		const destination = await deps.store.findDestination(scope, delivery.destinationId)
		const notification = await deps.store.findNotification(scope, delivery.notificationId)
		if (!destination || !notification) {
			await deps.withTransaction(async ({ notifications }) => {
				await notifications.settleDelivery(scope, delivery.id, {
					state: "abandoned",
					attempts: attempt,
					settledAt: deps.now(),
					lastError: "the destination was removed before this could be sent",
				})
			})
			return { settled: "abandoned" }
		}

		if (!destination.enabled) {
			await deps.withTransaction(async ({ notifications }) => {
				await notifications.settleDelivery(scope, delivery.id, {
					state: "abandoned",
					attempts: attempt,
					settledAt: deps.now(),
					lastError: "this destination was turned off before it could be sent",
				})
			})
			return { settled: "abandoned" }
		}

		const envelope: NotificationEnvelope = {
			id: notification.id,
			deliveryId: delivery.id,
			kind: notification.kind,
			title: notification.title,
			body: notification.body,
			subjectType: notification.subjectType,
			subjectId: notification.subjectId,
			occurredAt: notification.createdAt,
		}

		let outcome: DeliveryOutcome
		try {
			outcome = await deps.send(destination, envelope, deps.policy)
		} catch (error) {
			deps.onError?.(
				`Delivery ${delivery.id} could not be sent`,
				error instanceof Error ? error : GAVE_UP,
			)
			outcome = classifyRefusal(GAVE_UP)
		}
		if (outcome.kind !== "delivered" && outcome.detail !== undefined) {
			deps.onError?.(`Delivery ${delivery.id} was refused`, redact(outcome.detail))
		}

		const settledAt = deps.now()
		const lastError = outcome.kind === "delivered" ? null : redact(outcome.reason)
		const giveUp = outcome.kind === "terminal" || attempt >= retryLimit

		return await deps.withTransaction(async ({ notifications, runner }) => {
			await notifications.recordAttempt(scope, {
				deliveryId: delivery.id,
				attempt,
				outcome: outcome.kind,
				statusCode: outcome.statusCode ?? null,
				error: lastError,
			})

			if (outcome.kind === "delivered") {
				await notifications.settleDelivery(scope, delivery.id, {
					state: "delivered",
					attempts: attempt,
					settledAt,
					lastError: null,
				})
				await notifications.markDestinationOutcome(scope, destination.id, {
					succeededAt: settledAt,
					failedAt: null,
					reason: null,
				})
				return { settled: "delivered" }
			}

			await notifications.markDestinationOutcome(scope, destination.id, {
				succeededAt: null,
				failedAt: settledAt,
				reason: lastError,
			})

			if (giveUp) {
				if (outcome.kind === "terminal" && outcome.stopSending) {
					await notifications.disableDestination(scope, destination.id)
				}
				await notifications.settleDelivery(scope, delivery.id, {
					state: "failed",
					attempts: attempt,
					settledAt,
					lastError,
				})
				const dead = await deps.sendJob(
					NOTIFICATION_DEADLETTER_QUEUE,
					{
						organizationId: scope.organizationId,
						deliveryId: delivery.id,
						...carried,
					},
					runner,
				)
				if (dead === null) throw new InternalError("this delivery could not be set aside")
				return { settled: "failed" }
			}

			const afterSeconds = nextDelaySeconds(
				attempt,
				outcome.kind === "retryable" ? outcome.retryAfterSeconds : undefined,
			)
			await notifications.settleDelivery(scope, delivery.id, {
				state: "queued",
				attempts: attempt,
				settledAt: null,
				lastError,
			})
			const again = await deps.sendJob(
				deps.queue,
				{
					organizationId: scope.organizationId,
					deliveryId: delivery.id,
					attempt: `${attempt + 1}`,
					...carried,
				},
				runner,
				{ startAfterSeconds: afterSeconds },
			)
			if (again === null) throw new InternalError("this delivery could not be queued again")
			return { settled: "retrying", afterSeconds }
		})
	}

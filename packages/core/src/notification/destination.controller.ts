import {
	type CreateDestinationInput,
	can,
	type DeliveryProgress,
	type DestinationView,
	type EditDestinationInput,
	FAILURES_PAGE_SIZE,
	type FailuresInput,
	type FailuresPage,
	notificationCopy,
	ROTATION_OVERLAP_MS,
	type StoredDestinationConfig,
	signingSecretHint,
} from "@open-mcc/contracts"
import { readDestinationConfig } from "@open-mcc/contracts/boundary/destination-config"
import type { Db, NotificationDestinationRow } from "@open-mcc/db"
import { nanoid } from "nanoid"
import { type AuditRepository, createAuditRepository } from "../audit/audit.repository"
import type { SecretStore } from "../crypto/sealed-box"
import { type ActorContext, ForbiddenError } from "../host/host.controller"
import { asSqlRunner, type SqlRunner } from "../job/executor-adapter"
import type { QueueName, SendJob } from "../job/job.queue"
import { assertExhaustive } from "../lib/exhaustive"
import { carrierForActiveContext } from "../log/tracing"
import { queueFor } from "./announce"
import {
	shortFingerprint,
	telegramTarget,
	toDestinationView,
	webhookTarget,
} from "./destination.view"
import {
	type EgressPolicy,
	type RejectionCategory,
	verifyDestinationHost,
	verifyDestinationUrl,
} from "./egress"
import {
	createNotificationRepository,
	type NotificationRepository,
} from "./notification.repository"
import { verifyProviderUrl } from "./provider-url"
import { TEST_WINDOW_MS, TESTS_PER_WINDOW_PER_ORGANIZATION, throttleExceeded } from "./retention"
import { generateSigningSecret } from "./signature"

export class DestinationRejectedError extends Error {
	readonly category: RejectionCategory

	constructor(message: string, category: RejectionCategory) {
		super(message)
		this.category = category
	}
}

export class DestinationDisabledError extends Error {}

export class DestinationKindImmutableError extends Error {}

export class DestinationHasNoSigningKeyError extends Error {}

export class DestinationNotFoundError extends Error {}

export class DestinationTestThrottledError extends Error {}

export class OrganizationTestThrottledError extends Error {}

export class AlertNotQueuedError extends Error {}

export type DestinationTransactionRepos = {
	notifications: NotificationRepository
	audit: Pick<AuditRepository, "record">
	runner: SqlRunner
}

export type WithDestinationTransaction = <T>(
	fn: (repos: DestinationTransactionRepos) => Promise<T>,
) => Promise<T>

export const createDestinationControllerTransaction = (db: Db): WithDestinationTransaction => {
	const withTransaction: WithDestinationTransaction = (fn) =>
		db.transaction().execute((tx) =>
			fn({
				notifications: createNotificationRepository(tx),
				audit: createAuditRepository(tx),
				runner: asSqlRunner(tx),
			}),
		)
	return withTransaction
}

export type DestinationControllerDeps = {
	withTransaction: WithDestinationTransaction
	notifications: Pick<NotificationRepository, "listDestinations" | "subscriptionsFor">
	secrets: SecretStore
	sendJob: SendJob
	policy: EgressPolicy
	teamsHosts?: readonly string[]
	newSigningSecret?: () => string
	now?: () => Date
}

const POSTS_TO_A_URL = ["webhook", "discord", "slack", "teams"] as const

const postsToAUrl = (
	settings: StoredDestinationConfig,
): settings is Extract<StoredDestinationConfig, { kind: (typeof POSTS_TO_A_URL)[number] }> =>
	POSTS_TO_A_URL.some((kind) => kind === settings.kind)

const HAS_A_SERVER = ["gotify", "ntfy"] as const

const hasAServer = (
	settings: StoredDestinationConfig,
): settings is Extract<StoredDestinationConfig, { kind: (typeof HAS_A_SERVER)[number] }> =>
	HAS_A_SERVER.some((kind) => kind === settings.kind)

export const configurableUrl = (settings: StoredDestinationConfig): string | undefined => {
	if (postsToAUrl(settings)) return settings.config.url
	if (hasAServer(settings)) return settings.config.serverUrl
	return undefined
}

export const targetFor = (settings: StoredDestinationConfig): string => {
	if (settings.kind === "telegram") {
		return telegramTarget(settings.config.chatId, settings.config.messageThreadId)
	}
	if (settings.kind === "resend" || settings.kind === "email") return settings.config.fromAddress
	const url = configurableUrl(settings)
	return url === undefined ? settings.kind : webhookTarget(url)
}

const checkUrl = (
	settings: StoredDestinationConfig,
	policy: EgressPolicy,
	teamsHosts: readonly string[],
): void => {
	if (settings.kind === "email") {
		const host = verifyDestinationHost(settings.config.smtpServer, policy)
		if (!host.allowed) throw new DestinationRejectedError(host.reason, host.category)
		return
	}
	const url = configurableUrl(settings)
	if (url === undefined) return
	const shape = verifyProviderUrl(settings.kind, url, teamsHosts)
	if (!shape.allowed) throw new DestinationRejectedError(shape.reason, shape.category)
	const verdict = verifyDestinationUrl(url, policy)
	if (!verdict.allowed) throw new DestinationRejectedError(verdict.reason, verdict.category)
}

const acceptAlert = async (
	sendJob: SendJob,
	queue: QueueName,
	payload: Record<string, string>,
	runner: SqlRunner,
): Promise<void> => {
	let jobId: string | null
	try {
		jobId = await sendJob(queue, payload, runner)
	} catch (error) {
		if (!(error instanceof Error) || error.constructor !== Error) throw error
		throw new AlertNotQueuedError(error.message)
	}
	if (jobId === null) throw new AlertNotQueuedError("the alert was not accepted")
}

const requireManage = (actor: ActorContext): void => {
	if (!can(actor.role, "notification.manage")) {
		throw new ForbiddenError("You do not have permission to manage alerts")
	}
}

const requireRead = (actor: ActorContext): void => {
	if (!can(actor.role, "notification.read")) {
		throw new ForbiddenError("You do not have permission to see alerts")
	}
}

export const createDestinationController = (deps: DestinationControllerDeps) => {
	const now = deps.now ?? (() => new Date())
	const newSecret = deps.newSigningSecret ?? generateSigningSecret
	const teamsHosts = deps.teamsHosts ?? []

	const storedFor = (
		input: CreateDestinationInput["destination"],
		signingSecret: string | undefined,
		previous: { secret: string; expiresAt: string } | undefined,
	): StoredDestinationConfig => {
		switch (input.kind) {
			case "webhook":
				return {
					kind: "webhook",
					config: {
						url: input.config.url,
						signingSecret: signingSecret ?? newSecret(),
						...(previous === undefined
							? {}
							: {
									previousSigningSecret: previous.secret,
									previousSigningSecretExpiresAt: previous.expiresAt,
								}),
					},
				}
			case "telegram":
				return { kind: "telegram", config: input.config }
			case "discord":
				return { kind: "discord", config: input.config }
			case "slack":
				return { kind: "slack", config: input.config }
			case "teams":
				return { kind: "teams", config: input.config }
			case "gotify":
				return { kind: "gotify", config: input.config }
			case "ntfy":
				return { kind: "ntfy", config: input.config }
			case "resend":
				return { kind: "resend", config: input.config }
			case "email":
				return { kind: "email", config: input.config }
			default:
				return assertExhaustive(input)
		}
	}

	const settingsOf = (row: NotificationDestinationRow): StoredDestinationConfig | undefined => {
		try {
			return readDestinationConfig(
				row.kind,
				deps.secrets.open(row.secretEncrypted, row.secretKeyId),
			)
		} catch {
			return undefined
		}
	}

	return {
		list: async (actor: ActorContext): Promise<DestinationView[]> => {
			requireRead(actor)
			const scope = { organizationId: actor.organizationId }
			const rows = await deps.notifications.listDestinations(scope)
			const subscriptions = await deps.notifications.subscriptionsFor(
				scope,
				rows.map((row) => row.id),
			)
			return rows.map((row) => {
				const settings = settingsOf(row)
				return toDestinationView(
					{ ...row, displayTarget: settings ? targetFor(settings) : row.displayTarget },
					subscriptions
						.filter((entry) => entry.destinationId === row.id)
						.map((entry) => entry.kind),
					settings?.kind === "webhook" ? signingSecretHint(settings.config.signingSecret) : null,
					settings?.kind === "webhook" ? shortFingerprint(settings.config.url) : null,
				)
			})
		},

		create: async (
			actor: ActorContext,
			input: CreateDestinationInput,
		): Promise<{ destination: DestinationView; signingSecret: string | undefined }> => {
			requireManage(actor)
			const scope = { organizationId: actor.organizationId }
			const settings = storedFor(input.destination, undefined, undefined)
			checkUrl(settings, deps.policy, teamsHosts)

			const sealed = deps.secrets.seal(JSON.stringify(settings.config))
			return await deps.withTransaction(async ({ notifications, audit }) => {
				const row = await notifications.insertDestination(scope, {
					name: input.name,
					kind: settings.kind,
					displayTarget: targetFor(settings),
					secretEncrypted: sealed.ciphertext,
					secretKeyId: sealed.keyId,
				})
				await notifications.replaceSubscriptions(scope, row.id, input.subscribedTo)
				await audit.record(scope, {
					actorId: actor.memberId,
					actorLabel: actor.actorLabel,
					action: "notification.destination.create",
					subjectType: "notificationDestination",
					subjectId: row.id,
					detail: { name: row.name, kind: row.kind },
				})
				return {
					destination: toDestinationView(row, input.subscribedTo),
					signingSecret: settings.kind === "webhook" ? settings.config.signingSecret : undefined,
				}
			})
		},

		edit: async (actor: ActorContext, input: EditDestinationInput): Promise<DestinationView> => {
			requireManage(actor)
			const scope = { organizationId: actor.organizationId }

			return await deps.withTransaction(async ({ notifications, audit }) => {
				const row = await notifications.findDestination(scope, input.destinationId)
				if (!row) throw new DestinationNotFoundError("that destination no longer exists")
				if (row.kind !== input.destination.kind) {
					throw new DestinationKindImmutableError("a destination cannot change what it sends to")
				}

				const existing = readDestinationConfig(
					row.kind,
					deps.secrets.open(row.secretEncrypted, row.secretKeyId),
				)
				const keptSecret = existing?.kind === "webhook" ? existing.config.signingSecret : undefined
				const previous =
					existing?.kind === "webhook" ? existing.config.previousSigningSecret : undefined
				const previousExpiresAt =
					existing?.kind === "webhook" ? existing.config.previousSigningSecretExpiresAt : undefined
				const keptPrevious =
					previous !== undefined &&
					previousExpiresAt !== undefined &&
					new Date(previousExpiresAt).getTime() > now().getTime()
						? { secret: previous, expiresAt: previousExpiresAt }
						: undefined
				const settings = storedFor(input.destination, keptSecret, keptPrevious)
				checkUrl(settings, deps.policy, teamsHosts)

				const sealed = deps.secrets.seal(JSON.stringify(settings.config))
				const updated = await notifications.updateDestination(scope, input.destinationId, {
					name: input.name,
					displayTarget: targetFor(settings),
					secretEncrypted: sealed.ciphertext,
					secretKeyId: sealed.keyId,
				})
				if (!updated) throw new DestinationNotFoundError("that destination no longer exists")
				await notifications.replaceSubscriptions(scope, input.destinationId, input.subscribedTo)
				await audit.record(scope, {
					actorId: actor.memberId,
					actorLabel: actor.actorLabel,
					action: "notification.destination.edit",
					subjectType: "notificationDestination",
					subjectId: input.destinationId,
					detail: { name: input.name },
				})
				return toDestinationView(updated, input.subscribedTo)
			})
		},

		rotateSecret: async (actor: ActorContext, destinationId: string): Promise<string> => {
			requireManage(actor)
			const scope = { organizationId: actor.organizationId }

			return await deps.withTransaction(async ({ notifications, audit }) => {
				const row = await notifications.findDestination(scope, destinationId)
				if (!row) throw new DestinationNotFoundError("that destination no longer exists")
				const current = readDestinationConfig(
					row.kind,
					deps.secrets.open(row.secretEncrypted, row.secretKeyId),
				)
				if (current?.kind !== "webhook") {
					throw new DestinationHasNoSigningKeyError("only a webhook has a signing secret")
				}

				const replacement = newSecret()
				const settings = storedFor(
					{ kind: "webhook", config: { url: current.config.url } },
					replacement,
					{
						secret: current.config.signingSecret,
						expiresAt: new Date(now().getTime() + ROTATION_OVERLAP_MS).toISOString(),
					},
				)
				const sealed = deps.secrets.seal(JSON.stringify(settings.config))
				await notifications.updateDestination(scope, destinationId, {
					name: row.name,
					displayTarget: row.displayTarget,
					secretEncrypted: sealed.ciphertext,
					secretKeyId: sealed.keyId,
				})
				await audit.record(scope, {
					actorId: actor.memberId,
					actorLabel: actor.actorLabel,
					action: "notification.destination.rotate",
					subjectType: "notificationDestination",
					subjectId: destinationId,
					detail: {},
				})
				return replacement
			})
		},

		setEnabled: async (
			actor: ActorContext,
			destinationId: string,
			enabled: boolean,
		): Promise<number> => {
			requireManage(actor)
			const scope = { organizationId: actor.organizationId }

			return await deps.withTransaction(async ({ notifications, audit }) => {
				const changed = await notifications.setDestinationEnabled(scope, destinationId, enabled)
				if (!changed) throw new DestinationNotFoundError("that destination no longer exists")
				const abandoned = enabled
					? 0
					: await notifications.abandonQueuedFor(
							scope,
							destinationId,
							now(),
							"this destination was turned off before it could be sent",
						)
				await audit.record(scope, {
					actorId: actor.memberId,
					actorLabel: actor.actorLabel,
					action: enabled ? "notification.destination.enable" : "notification.destination.disable",
					subjectType: "notificationDestination",
					subjectId: destinationId,
					detail: { abandoned: `${abandoned}` },
				})
				return abandoned
			})
		},

		remove: async (actor: ActorContext, destinationId: string): Promise<void> => {
			requireManage(actor)
			const scope = { organizationId: actor.organizationId }

			await deps.withTransaction(async ({ notifications, audit }) => {
				const removed = await notifications.deleteDestination(scope, destinationId)
				if (!removed) throw new DestinationNotFoundError("that destination no longer exists")
				await audit.record(scope, {
					actorId: actor.memberId,
					actorLabel: actor.actorLabel,
					action: "notification.destination.delete",
					subjectType: "notificationDestination",
					subjectId: destinationId,
					detail: {},
				})
			})
		},

		deliveryState: async (actor: ActorContext, deliveryId: string): Promise<DeliveryProgress> => {
			requireRead(actor)
			const scope = { organizationId: actor.organizationId }
			return await deps.withTransaction(async ({ notifications }) => {
				const delivery = await notifications.findDelivery(scope, deliveryId)
				if (!delivery) throw new DestinationNotFoundError("that test is no longer around")
				return {
					state: delivery.state,
					reason: delivery.lastError,
					attempts: delivery.attempts,
				}
			})
		},

		failures: async (actor: ActorContext, input: FailuresInput): Promise<FailuresPage> => {
			requireRead(actor)
			const scope = { organizationId: actor.organizationId }
			return await deps.withTransaction(async ({ notifications }) => {
				const [items, total] = await Promise.all([
					notifications.recentFailures(scope, FAILURES_PAGE_SIZE, input.offset),
					notifications.failureCount(scope),
				])
				return { items, total, offset: input.offset }
			})
		},

		dismiss: async (actor: ActorContext, deliveryId: string): Promise<void> => {
			requireManage(actor)
			const scope = { organizationId: actor.organizationId }

			await deps.withTransaction(async ({ notifications, audit }) => {
				const dismissed = await notifications.dismissDelivery(scope, deliveryId, now())
				if (!dismissed) throw new DestinationNotFoundError("that alert is no longer waiting")

				await audit.record(scope, {
					actorId: actor.memberId,
					actorLabel: actor.actorLabel,
					action: "notification.delivery.dismiss",
					subjectType: "notificationDelivery",
					subjectId: deliveryId,
					detail: {},
				})
			})
		},

		retry: async (actor: ActorContext, deliveryId: string): Promise<void> => {
			requireManage(actor)
			const scope = { organizationId: actor.organizationId }

			await deps.withTransaction(async ({ notifications, audit, runner }) => {
				const existing = await notifications.findDelivery(scope, deliveryId)
				if (!existing) throw new DestinationNotFoundError("that alert is no longer waiting")

				const destination = await notifications.findDestination(scope, existing.destinationId)
				if (!destination) {
					throw new DestinationNotFoundError("that destination no longer exists")
				}
				if (!destination.enabled) {
					throw new DestinationDisabledError("that destination is turned off")
				}

				const requeued = await notifications.requeueDelivery(scope, deliveryId)
				if (!requeued) throw new DestinationNotFoundError("that alert is no longer waiting")

				await acceptAlert(
					deps.sendJob,
					queueFor(destination),
					{
						organizationId: scope.organizationId,
						deliveryId,
						attempt: "1",
						...carrierForActiveContext(),
					},
					runner,
				)

				await audit.record(scope, {
					actorId: actor.memberId,
					actorLabel: actor.actorLabel,
					action: "notification.delivery.retry",
					subjectType: "notificationDelivery",
					subjectId: deliveryId,
					detail: {},
				})
			})
		},

		test: async (actor: ActorContext, destinationId: string): Promise<string> => {
			requireManage(actor)
			const scope = { organizationId: actor.organizationId }

			return await deps.withTransaction(async ({ notifications, audit, runner }) => {
				const row = await notifications.findDestination(scope, destinationId)
				if (!row) throw new DestinationNotFoundError("that destination no longer exists")
				if (!row.enabled) {
					throw new DestinationDisabledError("that destination is turned off")
				}

				await notifications.lockTestsFor(scope)
				const since = new Date(now().getTime() - TEST_WINDOW_MS)
				const forDestination = await notifications.testsSince(scope, destinationId, since)
				if (throttleExceeded(forDestination)) {
					throw new DestinationTestThrottledError("this destination was tested a moment ago")
				}
				const forOrganization = await notifications.testsSince(scope, undefined, since)
				if (throttleExceeded(forOrganization, TESTS_PER_WINDOW_PER_ORGANIZATION)) {
					throw new OrganizationTestThrottledError("several tests were sent a moment ago")
				}

				const copy = notificationCopy("test", { name: row.name })
				const notification = await notifications.createNotification(scope, {
					kind: "test",
					title: copy.title,
					body: copy.body,
					subjectType: "host",
					subjectId: destinationId,
					dedupeKey: `test:${destinationId}:${nanoid()}`,
					sourceStatusEventId: null,
				})
				if (!notification) throw new AlertNotQueuedError("the test alert was not recorded")

				const delivery = await notifications.createDelivery(scope, {
					notificationId: notification.id,
					destinationId,
				})
				if (!delivery) throw new AlertNotQueuedError("the test alert was not recorded")

				await acceptAlert(
					deps.sendJob,
					queueFor(row),
					{
						organizationId: scope.organizationId,
						deliveryId: delivery.id,
						attempt: "1",
						...carrierForActiveContext(),
					},
					runner,
				)

				await audit.record(scope, {
					actorId: actor.memberId,
					actorLabel: actor.actorLabel,
					action: "notification.destination.test",
					subjectType: "notificationDestination",
					subjectId: destinationId,
					detail: {},
				})
				return delivery.id
			})
		},
	}
}

export type DestinationController = ReturnType<typeof createDestinationController>

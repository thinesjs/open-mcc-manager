import { z } from "zod"
import { NOTIFYING_EVENT_KINDS, RESOLVING_EVENT_KINDS } from "./status"

export const DESTINATION_KINDS = [
	"webhook",
	"telegram",
	"discord",
	"slack",
	"teams",
	"email",
	"resend",
	"gotify",
	"ntfy",
] as const

export const destinationKindSchema = z.enum(DESTINATION_KINDS)

export type DestinationKind = z.infer<typeof destinationKindSchema>

export const DESTINATION_LABELS: Record<DestinationKind, string> = {
	webhook: "Webhook",
	telegram: "Telegram",
	discord: "Discord",
	slack: "Slack",
	teams: "Microsoft Teams",
	email: "Email",
	resend: "Resend",
	gotify: "Gotify",
	ntfy: "ntfy",
}

export const HTTP_DESTINATION_KINDS: readonly DestinationKind[] = [
	"webhook",
	"telegram",
	"discord",
	"slack",
	"teams",
	"resend",
	"gotify",
	"ntfy",
]

export const usesEmailTransport = (kind: DestinationKind): boolean => kind === "email"

export const DELIVERY_STATES = ["queued", "delivered", "failed", "abandoned"] as const

export const deliveryStateSchema = z.enum(DELIVERY_STATES)

export type DeliveryState = z.infer<typeof deliveryStateSchema>

export const ATTEMPT_OUTCOMES = ["delivered", "retryable", "terminal"] as const

export const attemptOutcomeSchema = z.enum(ATTEMPT_OUTCOMES)

export type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>

export const SUBSCRIPTION_KINDS = NOTIFYING_EVENT_KINDS

export const subscriptionKindSchema = z.enum(SUBSCRIPTION_KINDS)

export type SubscriptionKind = z.infer<typeof subscriptionKindSchema>

export const TEST_NOTIFICATION_KIND = "test"

export const NOTIFICATION_KINDS = [
	...NOTIFYING_EVENT_KINDS,
	...RESOLVING_EVENT_KINDS,
	TEST_NOTIFICATION_KIND,
] as const

export const notificationKindSchema = z.enum(NOTIFICATION_KINDS)

export type NotificationKind = z.infer<typeof notificationKindSchema>

export const SIGNING_SECRET_PREFIX = "whsec_"

export const SIGNING_SECRET_BYTES = 32

export const SIGNATURE_VERSION = "v1"

export const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000

export const DELIVERY_RETRY_LIMIT = 8

export const DELIVERY_TIMEOUT_MS = 20_000

export const DELIVERY_MAX_RESPONSE_BYTES = 64 * 1024

export const webhookConfigInput = z.object({
	url: z.string().url().max(2048),
})

export const telegramConfigInput = z.object({
	botToken: z.string().min(1).max(256),
	chatId: z.string().min(1).max(64),
	messageThreadId: z.number().int().positive().optional(),
})

export const incomingWebhookConfigInput = z.object({
	url: z.string().url().max(2048),
})

export const gotifyConfigInput = z.object({
	serverUrl: z.string().url().max(2048),
	appToken: z.string().min(1).max(256),
	priority: z.number().int().min(0).max(10).default(5),
})

export const ntfyConfigInput = z.object({
	serverUrl: z.string().url().max(2048),
	topic: z.string().regex(/^[-_A-Za-z0-9]{1,64}$/),
	accessToken: z.string().max(256).optional(),
	priority: z.number().int().min(1).max(5).default(3),
})

export const resendConfigInput = z.object({
	apiKey: z.string().min(1).max(256),
	fromAddress: z.string().email(),
	toAddresses: z.array(z.string().email()).min(1).max(20),
})

export const emailConfigInput = z.object({
	smtpServer: z.string().min(1).max(253),
	smtpPort: z.number().int().min(1).max(65535),
	username: z.string().max(256),
	password: z.string().max(256),
	fromAddress: z.string().email(),
	toAddresses: z.array(z.string().email()).min(1).max(20),
})

export const webhookStoredConfig = webhookConfigInput.extend({
	signingSecret: z.string().min(1).max(128),
	previousSigningSecret: z.string().min(1).max(128).optional(),
	previousSigningSecretExpiresAt: z.string().datetime().optional(),
})

export const destinationConfigInput = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("webhook"), config: webhookConfigInput }),
	z.object({ kind: z.literal("telegram"), config: telegramConfigInput }),
	z.object({ kind: z.literal("discord"), config: incomingWebhookConfigInput }),
	z.object({ kind: z.literal("slack"), config: incomingWebhookConfigInput }),
	z.object({ kind: z.literal("teams"), config: incomingWebhookConfigInput }),
	z.object({ kind: z.literal("gotify"), config: gotifyConfigInput }),
	z.object({ kind: z.literal("ntfy"), config: ntfyConfigInput }),
	z.object({ kind: z.literal("resend"), config: resendConfigInput }),
	z.object({ kind: z.literal("email"), config: emailConfigInput }),
])

export type DestinationConfig = z.infer<typeof destinationConfigInput>

export const destinationStoredConfig = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("webhook"), config: webhookStoredConfig }),
	z.object({ kind: z.literal("telegram"), config: telegramConfigInput }),
	z.object({ kind: z.literal("discord"), config: incomingWebhookConfigInput }),
	z.object({ kind: z.literal("slack"), config: incomingWebhookConfigInput }),
	z.object({ kind: z.literal("teams"), config: incomingWebhookConfigInput }),
	z.object({ kind: z.literal("gotify"), config: gotifyConfigInput }),
	z.object({ kind: z.literal("ntfy"), config: ntfyConfigInput }),
	z.object({ kind: z.literal("resend"), config: resendConfigInput }),
	z.object({ kind: z.literal("email"), config: emailConfigInput }),
])

export type StoredDestinationConfig = z.infer<typeof destinationStoredConfig>

export const usableSigningSecrets = (
	config: z.infer<typeof webhookStoredConfig>,
	now: Date,
): readonly string[] => {
	const previous = config.previousSigningSecret
	const expiresAt = config.previousSigningSecretExpiresAt
	if (previous === undefined || expiresAt === undefined) return [config.signingSecret]
	const until = new Date(expiresAt)
	if (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) {
		return [config.signingSecret]
	}
	return [config.signingSecret, previous]
}

export const createDestinationInput = z.object({
	name: z.string().min(1).max(64),
	destination: destinationConfigInput,
	subscribedTo: z
		.array(subscriptionKindSchema)
		.min(1)
		.refine((kinds) => new Set(kinds).size === kinds.length, {
			message: "each alert can only be chosen once",
		}),
})

export const destinationIdInput = z.object({ destinationId: z.string().min(1) })

export type CreateDestinationInput = z.infer<typeof createDestinationInput>

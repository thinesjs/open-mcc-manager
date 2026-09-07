import type { NotificationKind } from "@open-mcc/contracts"
import { DELIVERY_TIMEOUT_MS, RESOLVING_EVENT_KINDS } from "@open-mcc/contracts"
import { parseTelegramReply } from "@open-mcc/contracts/boundary/telegram"
import { byteLength, truncateBytes, truncateChars } from "./bounds"
import type { EgressPolicy } from "./egress"
import { PUBLIC_ONLY, sanitisedTarget } from "./egress"
import { networkReason } from "./failure"
import {
	classifyDiscordReply,
	classifyHttpStatus,
	classifyNetworkFailure,
	classifyRefusal,
	classifyResendReply,
	classifyTelegramReply,
	type DeliveryOutcome,
} from "./outcome"
import type { PinnedRequest, PinnedResult } from "./pinned"
import { sendPinned } from "./pinned"
import { signatureHeader } from "./signature"

export type NotificationEnvelope = {
	readonly id: string
	readonly deliveryId: string
	readonly kind: NotificationKind
	readonly title: string
	readonly body: string
	readonly subjectType: "host" | "instance"
	readonly subjectId: string
	readonly occurredAt: Date
}

export type SendTransport = (request: PinnedRequest) => Promise<PinnedResult>

export type SenderDeps = {
	readonly transport?: SendTransport
	readonly policy?: EgressPolicy
	readonly now?: () => Date
}

export const webhookBody = (envelope: NotificationEnvelope): string =>
	JSON.stringify({
		type: envelope.kind,
		timestamp: envelope.occurredAt.toISOString(),
		data: {
			id: envelope.id,
			title: envelope.title,
			body: envelope.body,
			subject: { type: envelope.subjectType, id: envelope.subjectId },
		},
	})

const attempt = async (
	request: PinnedRequest,
	transport: SendTransport,
	onSent: (result: {
		status: number
		body: string
		headers: Readonly<Record<string, string>>
	}) => DeliveryOutcome,
): Promise<DeliveryOutcome> => {
	let result: PinnedResult
	try {
		result = await transport(request)
	} catch (error) {
		return classifyNetworkFailure(networkReason(error instanceof Error ? error : undefined))
	}
	if (!result.sent) return classifyRefusal(result.reason)
	return onSent(result)
}

export type WebhookSettings = {
	readonly url: string
	readonly signingSecrets: readonly string[]
}

export const deliverWebhook = async (
	settings: WebhookSettings,
	envelope: NotificationEnvelope,
	deps: SenderDeps = {},
): Promise<DeliveryOutcome> => {
	const transport = deps.transport ?? sendPinned
	const now = (deps.now ?? (() => new Date()))()
	const body = webhookBody(envelope)
	const timestamp = Math.floor(now.getTime() / 1000).toString()

	return await attempt(
		{
			url: settings.url,
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent": "OpenMCC",
				"webhook-id": envelope.id,
				"webhook-timestamp": timestamp,
				"webhook-signature": signatureHeader(settings.signingSecrets, envelope.id, timestamp, body),
			},
			body,
			timeoutMs: DELIVERY_TIMEOUT_MS,
			policy: deps.policy ?? PUBLIC_ONLY,
		},
		transport,
		(result) => classifyHttpStatus(result.status, result.headers["retry-after"], now),
	)
}

export type TelegramSettings = {
	readonly botToken: string
	readonly chatId: string
	readonly messageThreadId?: number
}

export const telegramText = (envelope: NotificationEnvelope): string =>
	`${envelope.title}\n${envelope.body}`

export const telegramUrl = (botToken: string): string =>
	`https://api.telegram.org/bot${botToken}/sendMessage`

export const deliverTelegram = async (
	settings: TelegramSettings,
	envelope: NotificationEnvelope,
	deps: SenderDeps = {},
): Promise<DeliveryOutcome> => {
	const transport = deps.transport ?? sendPinned

	return await attempt(
		{
			url: telegramUrl(settings.botToken),
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": "OpenMCC" },
			body: JSON.stringify({
				chat_id: settings.chatId,
				text: telegramText(envelope),
				disable_notification: false,
				disable_web_page_preview: true,
				...(settings.messageThreadId === undefined
					? {}
					: { message_thread_id: settings.messageThreadId }),
			}),
			timeoutMs: DELIVERY_TIMEOUT_MS,
			policy: deps.policy ?? PUBLIC_ONLY,
		},
		transport,
		(result) => classifyTelegramReply(result.status, parseTelegramReply(result.body)),
	)
}

export const DISCORD_CONTENT_CHARS = 2000

export const SLACK_TEXT_CHARS = 4000

export const TEAMS_BODY_BYTES = 25_000

export const TEAMS_TEXT_BYTES = 20_000

export const TEAMS_TITLE_CHARS = 250

export const NTFY_MESSAGE_BYTES = 4096

export const NTFY_TITLE_CHARS = 250

export const OPERATIONAL_TEXT_CHARS = 4000

const RESOLVING: ReadonlySet<string> = new Set<string>(RESOLVING_EVENT_KINDS)

const JSON_HEADERS: Readonly<Record<string, string>> = {
	"content-type": "application/json",
	"user-agent": "OpenMCC",
}

const plainText = (envelope: NotificationEnvelope): string => `${envelope.title}\n${envelope.body}`

export type IncomingWebhookSettings = {
	readonly url: string
}

export const discordContent = (envelope: NotificationEnvelope): string =>
	truncateChars(plainText(envelope), DISCORD_CONTENT_CHARS)

export const discordBody = (envelope: NotificationEnvelope): string =>
	JSON.stringify({ content: discordContent(envelope) })

export const deliverDiscord = async (
	settings: IncomingWebhookSettings,
	envelope: NotificationEnvelope,
	deps: SenderDeps = {},
): Promise<DeliveryOutcome> => {
	const transport = deps.transport ?? sendPinned
	const now = (deps.now ?? (() => new Date()))()

	return await attempt(
		{
			url: settings.url,
			method: "POST",
			headers: JSON_HEADERS,
			body: discordBody(envelope),
			timeoutMs: DELIVERY_TIMEOUT_MS,
			policy: deps.policy ?? PUBLIC_ONLY,
		},
		transport,
		(result) =>
			classifyDiscordReply(result.status, result.headers["retry-after"], result.body, now),
	)
}

export const slackText = (envelope: NotificationEnvelope): string =>
	truncateChars(plainText(envelope), SLACK_TEXT_CHARS)

export const slackBody = (envelope: NotificationEnvelope): string =>
	JSON.stringify({ text: slackText(envelope) })

export const deliverSlack = async (
	settings: IncomingWebhookSettings,
	envelope: NotificationEnvelope,
	deps: SenderDeps = {},
): Promise<DeliveryOutcome> => {
	const transport = deps.transport ?? sendPinned
	const now = (deps.now ?? (() => new Date()))()

	return await attempt(
		{
			url: settings.url,
			method: "POST",
			headers: JSON_HEADERS,
			body: slackBody(envelope),
			timeoutMs: DELIVERY_TIMEOUT_MS,
			policy: deps.policy ?? PUBLIC_ONLY,
		},
		transport,
		(result) => classifyHttpStatus(result.status, result.headers["retry-after"], now),
	)
}

export const teamsTitle = (envelope: NotificationEnvelope): string =>
	`${RESOLVING.has(envelope.kind) ? "\u2705" : "\u26a0\ufe0f"} ${truncateChars(envelope.title, TEAMS_TITLE_CHARS)}`

export const teamsText = (envelope: NotificationEnvelope): string =>
	truncateBytes(envelope.body, TEAMS_TEXT_BYTES)

export const teamsBody = (envelope: NotificationEnvelope): string =>
	JSON.stringify({
		type: "message",
		attachments: [
			{
				contentType: "application/vnd.microsoft.card.adaptive",
				content: {
					type: "AdaptiveCard",
					$schema: "http://adaptivecards.io/schemas/adaptive-card.json",
					version: "1.2",
					body: [
						{
							type: "TextBlock",
							text: teamsTitle(envelope),
							size: "Medium",
							weight: "Bolder",
							wrap: true,
						},
						{ type: "TextBlock", text: teamsText(envelope), wrap: true },
					],
				},
			},
		],
	})

export const deliverTeams = async (
	settings: IncomingWebhookSettings,
	envelope: NotificationEnvelope,
	deps: SenderDeps = {},
): Promise<DeliveryOutcome> => {
	const transport = deps.transport ?? sendPinned
	const now = (deps.now ?? (() => new Date()))()

	return await attempt(
		{
			url: settings.url,
			method: "POST",
			headers: JSON_HEADERS,
			body: teamsBody(envelope),
			timeoutMs: DELIVERY_TIMEOUT_MS,
			policy: deps.policy ?? PUBLIC_ONLY,
		},
		transport,
		(result) => classifyHttpStatus(result.status, result.headers["retry-after"], now),
	)
}

export type GotifySettings = {
	readonly serverUrl: string
	readonly appToken: string
	readonly priority: number
}

export const gotifyUrl = (serverUrl: string): string => `${serverUrl.replace(/\/+$/, "")}/message`

export const gotifyBody = (envelope: NotificationEnvelope, priority: number): string =>
	JSON.stringify({
		title: truncateChars(envelope.title, TEAMS_TITLE_CHARS),
		message: truncateChars(envelope.body, OPERATIONAL_TEXT_CHARS),
		priority,
		extras: { "client::display": { contentType: "text/plain" } },
	})

export const deliverGotify = async (
	settings: GotifySettings,
	envelope: NotificationEnvelope,
	deps: SenderDeps = {},
): Promise<DeliveryOutcome> => {
	const transport = deps.transport ?? sendPinned
	const now = (deps.now ?? (() => new Date()))()

	return await attempt(
		{
			url: gotifyUrl(settings.serverUrl),
			method: "POST",
			headers: { ...JSON_HEADERS, "x-gotify-key": settings.appToken },
			body: gotifyBody(envelope, settings.priority),
			timeoutMs: DELIVERY_TIMEOUT_MS,
			policy: deps.policy ?? PUBLIC_ONLY,
		},
		transport,
		(result) => classifyHttpStatus(result.status, result.headers["retry-after"], now),
	)
}

export type NtfySettings = {
	readonly serverUrl: string
	readonly topic: string
	readonly priority: number
	readonly accessToken?: string
}

export const ntfyMessage = (envelope: NotificationEnvelope): string =>
	truncateBytes(envelope.body, NTFY_MESSAGE_BYTES)

export const ntfyUrl = (serverUrl: string, topic: string): string =>
	`${serverUrl.replace(/\/+$/, "")}/${topic}`

export const deliverNtfy = async (
	settings: NtfySettings,
	envelope: NotificationEnvelope,
	deps: SenderDeps = {},
): Promise<DeliveryOutcome> => {
	const transport = deps.transport ?? sendPinned
	const now = (deps.now ?? (() => new Date()))()

	return await attempt(
		{
			url: ntfyUrl(settings.serverUrl, settings.topic),
			method: "POST",
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"user-agent": "OpenMCC",
				"x-title": truncateChars(envelope.title, NTFY_TITLE_CHARS),
				"x-priority": String(settings.priority),
				...(settings.accessToken === undefined
					? {}
					: { authorization: `Bearer ${settings.accessToken}` }),
			},
			body: ntfyMessage(envelope),
			timeoutMs: DELIVERY_TIMEOUT_MS,
			policy: deps.policy ?? PUBLIC_ONLY,
		},
		transport,
		(result) => classifyHttpStatus(result.status, result.headers["retry-after"], now),
	)
}

export type ResendSettings = {
	readonly apiKey: string
	readonly fromAddress: string
	readonly toAddresses: readonly string[]
}

export const RESEND_URL = "https://api.resend.com/emails"

export const resendBody = (
	envelope: NotificationEnvelope,
	from: string,
	to: readonly string[],
): string =>
	JSON.stringify({
		from,
		to: [...to],
		subject: truncateChars(envelope.title, TEAMS_TITLE_CHARS),
		text: truncateChars(envelope.body, OPERATIONAL_TEXT_CHARS),
	})

export const deliverResend = async (
	settings: ResendSettings,
	envelope: NotificationEnvelope,
	deps: SenderDeps = {},
): Promise<DeliveryOutcome> => {
	const transport = deps.transport ?? sendPinned
	const now = (deps.now ?? (() => new Date()))()

	return await attempt(
		{
			url: RESEND_URL,
			method: "POST",
			headers: {
				...JSON_HEADERS,
				authorization: `Bearer ${settings.apiKey}`,
				"idempotency-key": envelope.deliveryId,
			},
			body: resendBody(envelope, settings.fromAddress, settings.toAddresses),
			timeoutMs: DELIVERY_TIMEOUT_MS,
			policy: deps.policy ?? PUBLIC_ONLY,
		},
		transport,
		(result) => classifyResendReply(result.status, result.headers["retry-after"], result.body, now),
	)
}

export const fitsTeamsMessage = (body: string): boolean => byteLength(body) <= TEAMS_BODY_BYTES

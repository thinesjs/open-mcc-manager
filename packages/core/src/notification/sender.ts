import type { NotificationKind } from "@open-mcc/contracts"
import { DELIVERY_TIMEOUT_MS } from "@open-mcc/contracts"
import { parseTelegramReply } from "@open-mcc/contracts/boundary/telegram"
import { redact } from "../security/redact"
import type { EgressPolicy } from "./egress"
import { PUBLIC_ONLY, sanitisedTarget } from "./egress"
import {
	classifyHttpStatus,
	classifyNetworkFailure,
	classifyRefusal,
	classifyTelegramReply,
	type DeliveryOutcome,
} from "./outcome"
import type { PinnedRequest, PinnedResult } from "./pinned"
import { sendPinned } from "./pinned"
import { signatureHeader } from "./signature"

export type NotificationEnvelope = {
	readonly id: string
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

const pathOf = (url: string): string | undefined => {
	const scheme = url.indexOf("://")
	if (scheme === -1) return undefined
	const slash = url.indexOf("/", scheme + 3)
	return slash === -1 ? undefined : url.slice(slash)
}

export const withoutTarget = (message: string, url: string): string => {
	const stripped = message.split(url).join(sanitisedTarget(url))
	const path = pathOf(url)
	return path === undefined || path.length <= 1 ? stripped : stripped.split(path).join("/…")
}

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
		return classifyNetworkFailure(
			redact(
				withoutTarget(
					error instanceof Error ? error.message : "the delivery did not go through",
					request.url,
				),
			),
		)
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

export const deliveryTarget = (kind: "webhook" | "telegram", settings: string): string =>
	kind === "telegram" ? "Telegram" : sanitisedTarget(settings)

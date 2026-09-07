import { createHash } from "node:crypto"
import {
	DESTINATION_LABELS,
	type DestinationView,
	type SubscriptionKind,
} from "@open-mcc/contracts"
import type { NotificationDestinationRow } from "@open-mcc/db"
import { sanitisedTarget } from "./egress"

export const shortFingerprint = (value: string): string =>
	createHash("sha256").update(value, "utf8").digest("hex").slice(0, 6)

export const maskedChatId = (chatId: string): string =>
	chatId.length <= 4 ? `chat …${chatId}` : `chat …${chatId.slice(-4)}`

export const webhookTarget = (url: string): string => sanitisedTarget(url)

export const telegramTarget = (chatId: string, threadId: number | undefined): string =>
	threadId === undefined
		? `Telegram, ${maskedChatId(chatId)}`
		: `Telegram, ${maskedChatId(chatId)}, topic ${threadId}`

export const toDestinationView = (
	row: NotificationDestinationRow,
	subscribedTo: readonly SubscriptionKind[],
	signingKeyHint: string | null = null,
	targetFingerprint: string | null = null,
): DestinationView => ({
	id: row.id,
	name: row.name,
	kind: row.kind,
	kindLabel: DESTINATION_LABELS[row.kind],
	enabled: row.enabled,
	target: row.displayTarget,
	subscribedTo,
	lastSucceededAt: row.lastSucceededAt,
	lastFailedAt: row.lastFailedAt,
	lastFailureReason: row.lastFailureReason,
	signingKeyHint,
	targetFingerprint,
})

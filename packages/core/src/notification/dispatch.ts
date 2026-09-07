import { usableSigningSecrets } from "@open-mcc/contracts"
import { readDestinationConfig } from "@open-mcc/contracts/boundary/destination-config"
import type { NotificationDestinationRow } from "@open-mcc/db"
import type { SecretStore } from "../crypto/sealed-box"
import type { EgressPolicy } from "./egress"
import type { DeliveryOutcome } from "./outcome"
import { classifyRefusal } from "./outcome"
import type { NotificationEnvelope } from "./sender"
import { deliverTelegram, deliverWebhook } from "./sender"

const UNREADABLE = "this destination's settings could not be read"

export const dispatchTo = async (
	destination: NotificationDestinationRow,
	envelope: NotificationEnvelope,
	policy: EgressPolicy,
	secrets: SecretStore,
	now: () => Date = () => new Date(),
): Promise<DeliveryOutcome> => {
	let opened: string
	try {
		opened = secrets.open(destination.secretEncrypted, destination.secretKeyId)
	} catch {
		return classifyRefusal(UNREADABLE)
	}

	const settings = readDestinationConfig(destination.kind, opened)
	if (!settings) return classifyRefusal(UNREADABLE)
	if (settings.kind === "telegram") {
		return await deliverTelegram(
			{
				botToken: settings.config.botToken,
				chatId: settings.config.chatId,
				...(settings.config.messageThreadId === undefined
					? {}
					: { messageThreadId: settings.config.messageThreadId }),
			},
			envelope,
			{ policy },
		)
	}
	if (settings.kind === "webhook") {
		return await deliverWebhook(
			{
				url: settings.config.url,
				signingSecrets: usableSigningSecrets(settings.config, now()),
			},
			envelope,
			{ policy },
		)
	}
	return classifyRefusal("this kind of destination cannot be sent to yet")
}

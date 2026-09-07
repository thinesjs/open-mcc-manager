import { usableSigningSecrets } from "@open-mcc/contracts"
import { readDestinationConfig } from "@open-mcc/contracts/boundary/destination-config"
import type { NotificationDestinationRow } from "@open-mcc/db"
import type { SecretStore } from "../crypto/sealed-box"
import type { EgressPolicy } from "./egress"
import type { DeliveryOutcome } from "./outcome"
import { classifyRefusal } from "./outcome"
import type { NotificationEnvelope } from "./sender"
import {
	deliverDiscord,
	deliverGotify,
	deliverNtfy,
	deliverResend,
	deliverSlack,
	deliverTeams,
	deliverTelegram,
	deliverWebhook,
} from "./sender"

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
	if (settings.kind === "discord") {
		return await deliverDiscord({ url: settings.config.url }, envelope, { policy })
	}
	if (settings.kind === "slack") {
		return await deliverSlack({ url: settings.config.url }, envelope, { policy })
	}
	if (settings.kind === "teams") {
		return await deliverTeams({ url: settings.config.url }, envelope, { policy })
	}
	if (settings.kind === "gotify") {
		return await deliverGotify(
			{
				serverUrl: settings.config.serverUrl,
				appToken: settings.config.appToken,
				priority: settings.config.priority,
			},
			envelope,
			{ policy },
		)
	}
	if (settings.kind === "ntfy") {
		return await deliverNtfy(
			{
				serverUrl: settings.config.serverUrl,
				topic: settings.config.topic,
				priority: settings.config.priority,
				...(settings.config.accessToken === undefined
					? {}
					: { accessToken: settings.config.accessToken }),
			},
			envelope,
			{ policy },
		)
	}
	if (settings.kind === "resend") {
		return await deliverResend(
			{
				apiKey: settings.config.apiKey,
				fromAddress: settings.config.fromAddress,
				toAddresses: settings.config.toAddresses,
			},
			envelope,
			{ policy },
		)
	}
	return classifyRefusal("this kind of destination cannot be sent to yet")
}

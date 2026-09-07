import {
	DESTINATION_KINDS,
	type DestinationKind,
	type StoredDestinationConfig,
} from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import { targetFor } from "./destination.controller"

const SECRETS = [
	"whsec_signing",
	"7654321:AAF-bot-token-value",
	"discord-path-token",
	"slack-path-token",
	"teams-signature-value",
	"gotify-app-token",
	"ntfy-access-token",
	"open-mcc-topic",
	"re_live_api_key",
	"on-call@example.com",
	"smtp-password",
] as const

const stored: Record<DestinationKind, StoredDestinationConfig> = {
	webhook: {
		kind: "webhook",
		config: {
			url: "https://hooks.example.com/alerts/whsec_signing",
			signingSecret: "whsec_signing",
		},
	},
	telegram: {
		kind: "telegram",
		config: { botToken: "7654321:AAF-bot-token-value", chatId: "-1001234567890" },
	},
	discord: {
		kind: "discord",
		config: { url: "https://discord.com/api/webhooks/1/discord-path-token" },
	},
	slack: {
		kind: "slack",
		config: { url: "https://hooks.slack.com/services/T/B/slack-path-token" },
	},
	teams: {
		kind: "teams",
		config: {
			url: "https://abc.05.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/9f/triggers/manual/paths/invoke?api-version=1&sig=teams-signature-value",
		},
	},
	gotify: {
		kind: "gotify",
		config: { serverUrl: "https://push.example.com", appToken: "gotify-app-token", priority: 5 },
	},
	ntfy: {
		kind: "ntfy",
		config: {
			serverUrl: "https://ntfy.example.com",
			topic: "open-mcc-topic",
			accessToken: "ntfy-access-token",
			priority: 3,
		},
	},
	resend: {
		kind: "resend",
		config: {
			apiKey: "re_live_api_key",
			fromAddress: "alerts@example.com",
			toAddresses: ["on-call@example.com"],
		},
	},
	email: {
		kind: "email",
		config: {
			smtpServer: "smtp.example.com",
			smtpPort: 587,
			username: "alerts",
			password: "smtp-password",
			fromAddress: "alerts@example.com",
			toAddresses: ["on-call@example.com"],
		},
	},
}

const EXPECTED: Record<DestinationKind, string> = {
	webhook: "https://hooks.example.com/…",
	telegram: "Telegram, chat …7890",
	discord: "https://discord.com/…",
	slack: "https://hooks.slack.com/…",
	teams: "https://abc.05.environment.api.powerplatform.com/…",
	gotify: "https://push.example.com",
	ntfy: "https://ntfy.example.com",
	resend: "alerts@example.com",
	email: "alerts@example.com",
}

describe("what an operator is shown about where a destination sends", () => {
	it("never shows a secret for any kind", () => {
		for (const kind of DESTINATION_KINDS) {
			const shown = targetFor(stored[kind])
			for (const secret of SECRETS) {
				expect(shown, `${kind} leaked ${secret}`).not.toContain(secret)
			}
		}
	})

	it("shows something recognisable for every kind", () => {
		for (const kind of DESTINATION_KINDS) {
			expect(targetFor(stored[kind]), kind).toBe(EXPECTED[kind])
		}
	})
})

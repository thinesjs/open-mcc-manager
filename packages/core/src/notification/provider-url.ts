import type { DestinationKind, RejectionCategory } from "@open-mcc/contracts"
import { bareHostname } from "./egress"

export type ProviderUrlVerdict =
	| { readonly allowed: true }
	| { readonly allowed: false; readonly reason: string; readonly category: RejectionCategory }

export const TEAMS_HOST_SUFFIX = "environment.api.powerplatform.com"

const DISCORD_HOSTS = ["discord.com", "discordapp.com"] as const

const SLACK_HOST = "hooks.slack.com"

const RETIRED_TEAMS_HOSTS = ["webhook.office.com", "logic.azure.com"] as const

const matchesHost = (hostname: string, candidate: string): boolean =>
	hostname === candidate || hostname.endsWith(`.${candidate}`)

const refuse = (reason: string, category: RejectionCategory): ProviderUrlVerdict => ({
	allowed: false,
	reason,
	category,
})

const ALLOWED: ProviderUrlVerdict = { allowed: true }

export const verifyProviderUrl = (
	kind: DestinationKind,
	raw: string,
	extraTeamsHosts: readonly string[] = [],
): ProviderUrlVerdict => {
	if (kind === "webhook" || kind === "telegram" || kind === "resend" || kind === "email") {
		return ALLOWED
	}

	let parsed: URL
	try {
		parsed = new URL(raw)
	} catch {
		return refuse("that does not look like a web address", "unreadable")
	}
	const hostname = bareHostname(parsed.hostname).toLowerCase()

	if (kind === "discord") {
		return DISCORD_HOSTS.some((host) => matchesHost(hostname, host))
			? ALLOWED
			: refuse("that is not a Discord webhook address", "host")
	}

	if (kind === "slack") {
		return hostname === SLACK_HOST ? ALLOWED : refuse("that is not a Slack webhook address", "host")
	}

	if (kind === "teams") {
		if (RETIRED_TEAMS_HOSTS.some((host) => matchesHost(hostname, host))) {
			return refuse("that kind of Teams address no longer works", "retired")
		}
		const suffixes = [TEAMS_HOST_SUFFIX, ...extraTeamsHosts]
		if (!suffixes.some((suffix) => matchesHost(hostname, suffix))) {
			return refuse("that is not a Teams workflow address", "host")
		}
		const signature = parsed.searchParams.get("sig")
		return signature !== null && signature.length > 0
			? ALLOWED
			: refuse("that workflow requires someone to sign in", "signin")
	}

	if (parsed.search.length > 0) {
		return refuse("a server address cannot carry anything after a question mark", "parameters")
	}
	return ALLOWED
}

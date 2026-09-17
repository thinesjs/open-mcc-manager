const COMMAND_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/^([ \t]*[/!]{0,2}(?:authme[ \t]+(?:register|reg|r|password|changepassword|changepass|cp)|email[ \t]+setpassword))[ \t]+\S[^\r\n]*/gim,
		"$1 [redacted]",
	],
	[
		/^([ \t]*[/!]{0,2}(?:changepassword|changepass|unregister|register|login|unreg|reg|log|cp|l))[ \t]+\S[^\r\n]*/gim,
		"$1 [redacted]",
	],
]

export const UNAMBIGUOUS_SECRET_PATTERNS = {
	authorizationBearer: [/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]"],
	privateKeyBlock: [
		/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
		"[redacted private key]",
	],
	sealboxKeys: [/(SEALBOX_KEYS=)\S+/g, "$1[redacted]"],
	signingSecret: [/whsec_[A-Za-z0-9+/=]+/g, "[redacted secret]"],
	telegramBotUrl: [/(https:\/\/api\.telegram\.org\/bot)[^/\s]+/gi, "$1[redacted]"],
	slackWebhook: [/(https:\/\/hooks\.slack\.com\/services)\/\S+/gi, "$1/[redacted]"],
	discordWebhook: [
		/(https:\/\/(?:[^\s/]*\.)?discord(?:app)?\.com\/api\/webhooks)\/\S+/gi,
		"$1/[redacted]",
	],
	teamsWebhook: [/(https:\/\/[^\s/]*webhook\.office\.com\/webhookb2)\/\S+/gi, "$1/[redacted]"],
	powerPlatformWorkflow: [
		/(https:\/\/[^\s/]*\.environment\.api\.powerplatform\.[a-z]{2,})\/\S+/gi,
		"$1/[redacted]",
	],
	azureLogicWorkflow: [
		/(https:\/\/[^\s/]*\.logic\.azure\.com(?::\d+)?\/workflows)\/\S+/gi,
		"$1/[redacted]",
	],
	signedUrlQuery: [/([?&]sig=)[^&\s"']+/gi, "$1[redacted]"],
	gotifyKey: [/((?:X-Gotify-Key|x-gotify-key)\s*[:=]\s*)\S+/g, "$1[redacted]"],
	resendKey: [/(^|[^A-Za-z0-9_-])(re_)[A-Za-z0-9]{16,}/g, "$1$2[redacted]"],
} as const

const mask = (patterns: ReadonlyArray<readonly [RegExp, string]>, value: string): string =>
	patterns.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), value)

export const maskCommandCredentials = (command: string): string => mask(COMMAND_PATTERNS, command)

export const maskUnambiguousSecrets = (value: string): string =>
	mask(Object.values(UNAMBIGUOUS_SECRET_PATTERNS), value)

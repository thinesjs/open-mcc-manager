import { maskCommandCredentials, UNAMBIGUOUS_SECRET_PATTERNS } from "@open-mcc/contracts"

const BEARER_TOKEN: readonly [RegExp, string] = [
	/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
	"$1[redacted]",
]

const DEVICE_CODE: readonly [RegExp, string] = [/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, "[redacted code]"]

const TELEGRAM_BOT_TOKEN: readonly [RegExp, string] = [
	/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g,
	"[redacted token]",
]

const SMTP_AUTH_PLAIN: readonly [RegExp, string] = [/(AUTH\s+PLAIN\s+)\S+/gi, "$1[redacted]"]

export const LOG_ONLY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	BEARER_TOKEN,
	DEVICE_CODE,
	TELEGRAM_BOT_TOKEN,
	SMTP_AUTH_PLAIN,
]

export const REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	BEARER_TOKEN,
	UNAMBIGUOUS_SECRET_PATTERNS.privateKeyBlock,
	DEVICE_CODE,
	UNAMBIGUOUS_SECRET_PATTERNS.sealboxKeys,
	UNAMBIGUOUS_SECRET_PATTERNS.signingSecret,
	UNAMBIGUOUS_SECRET_PATTERNS.telegramBotUrl,
	TELEGRAM_BOT_TOKEN,
	UNAMBIGUOUS_SECRET_PATTERNS.slackWebhook,
	UNAMBIGUOUS_SECRET_PATTERNS.discordWebhook,
	UNAMBIGUOUS_SECRET_PATTERNS.teamsWebhook,
	UNAMBIGUOUS_SECRET_PATTERNS.powerPlatformWorkflow,
	UNAMBIGUOUS_SECRET_PATTERNS.azureLogicWorkflow,
	UNAMBIGUOUS_SECRET_PATTERNS.signedUrlQuery,
	UNAMBIGUOUS_SECRET_PATTERNS.gotifyKey,
	SMTP_AUTH_PLAIN,
	UNAMBIGUOUS_SECRET_PATTERNS.resendKey,
]

export const redact = (value: string): string =>
	REDACTION_PATTERNS.reduce(
		(acc, [pattern, replacement]) => acc.replace(pattern, replacement),
		value,
	)

export const REDACTED_CREDENTIAL = "[redacted credential]"

export const redactValue = (value: string, secret: string): string =>
	redact(secret.length === 0 ? value : value.split(secret).join(REDACTED_CREDENTIAL))

export const redactCommand = (command: string): string => maskCommandCredentials(redact(command))

export const redactError = (error: Error | string): string =>
	redact(typeof error === "string" ? error : (error.stack ?? `${error.name}: ${error.message}`))

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]"],
	[
		/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
		"[redacted private key]",
	],
	[/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, "[redacted code]"],
	[/(SEALBOX_KEYS=)\S+/g, "$1[redacted]"],
	[/whsec_[A-Za-z0-9+/=]+/g, "[redacted secret]"],
	[/(https:\/\/api\.telegram\.org\/bot)[^/\s]+/gi, "$1[redacted]"],
	[/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, "[redacted token]"],
	[/(https:\/\/hooks\.slack\.com\/services)\/\S+/gi, "$1/[redacted]"],
	[/(https:\/\/discord(?:app)?\.com\/api\/webhooks)\/\S+/gi, "$1/[redacted]"],
	[/(https:\/\/[^\s/]*webhook\.office\.com\/webhookb2)\/\S+/gi, "$1/[redacted]"],
	[/(?<![A-Za-z0-9_-])(re_)[A-Za-z0-9]{16,}/g, "$1[redacted]"],
]

export const redact = (value: string): string =>
	PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), value)

export const redactError = (error: Error | string): string =>
	redact(typeof error === "string" ? error : (error.stack ?? `${error.name}: ${error.message}`))

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]"],
	[
		/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
		"[redacted private key]",
	],
	[/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, "[redacted code]"],
	[/(SEALBOX_KEYS=)\S+/g, "$1[redacted]"],
]

export const redact = (value: string): string =>
	PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), value)

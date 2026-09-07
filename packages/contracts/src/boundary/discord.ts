const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined

export const parseDiscordRetryAfter = (raw: string): number | undefined => {
	let decoded: unknown
	try {
		decoded = JSON.parse(raw)
	} catch {
		return undefined
	}
	const body = asRecord(decoded)
	if (!body) return undefined
	const asked = body.retry_after
	if (typeof asked !== "number") return undefined
	if (!Number.isFinite(asked) || asked < 0) return undefined
	return Math.ceil(asked)
}

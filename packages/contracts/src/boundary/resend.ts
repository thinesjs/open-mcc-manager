const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined

export const parseResendErrorName = (raw: string): string | undefined => {
	let decoded: unknown
	try {
		decoded = JSON.parse(raw)
	} catch {
		return undefined
	}
	const body = asRecord(decoded)
	if (!body) return undefined
	const name = body.name
	return typeof name === "string" && name.length > 0 ? name : undefined
}

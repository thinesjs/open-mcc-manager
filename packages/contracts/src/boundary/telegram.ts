export type TelegramReply = {
	ok: boolean
	errorCode: number | undefined
	description: string | undefined
	retryAfterSeconds: number | undefined
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined

const asWholeNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined

export const parseTelegramReply = (raw: string): TelegramReply | undefined => {
	let decoded: unknown
	try {
		decoded = JSON.parse(raw)
	} catch {
		return undefined
	}
	const body = asRecord(decoded)
	if (!body) return undefined
	if (typeof body.ok !== "boolean") return undefined

	const parameters = asRecord(body.parameters)
	return {
		ok: body.ok,
		errorCode: asWholeNumber(body.error_code),
		description: asString(body.description),
		retryAfterSeconds: parameters === undefined ? undefined : asWholeNumber(parameters.retry_after),
	}
}

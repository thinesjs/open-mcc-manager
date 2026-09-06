export type DeliveryOutcome =
	| { kind: "delivered"; statusCode: number | undefined }
	| { kind: "retryable"; statusCode: number | undefined; reason: string }
	| { kind: "terminal"; statusCode: number | undefined; reason: string }

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504])

export const classifyHttpStatus = (status: number): DeliveryOutcome => {
	if (status >= 200 && status < 300) return { kind: "delivered", statusCode: status }
	if (RETRYABLE_STATUS.has(status) || status >= 500) {
		return { kind: "retryable", statusCode: status, reason: `Server answered ${status}` }
	}
	return { kind: "terminal", statusCode: status, reason: `Server refused with ${status}` }
}

export const classifyNetworkFailure = (reason: string): DeliveryOutcome => ({
	kind: "retryable",
	statusCode: undefined,
	reason,
})

const TELEGRAM_TERMINAL: ReadonlySet<number> = new Set([400, 401, 403, 404])

export type TelegramReply = {
	ok: boolean
	errorCode: number | undefined
	description: string | undefined
	retryAfterSeconds: number | undefined
}

export const classifyTelegramReply = (
	httpStatus: number,
	reply: TelegramReply | undefined,
): DeliveryOutcome => {
	if (reply === undefined) return classifyHttpStatus(httpStatus)
	if (reply.ok) return { kind: "delivered", statusCode: httpStatus }

	const code = reply.errorCode ?? httpStatus
	const reason = reply.description ?? `Telegram refused with ${code}`
	if (code === 429) return { kind: "retryable", statusCode: code, reason }
	if (TELEGRAM_TERMINAL.has(code)) return { kind: "terminal", statusCode: code, reason }
	return { kind: "retryable", statusCode: code, reason }
}

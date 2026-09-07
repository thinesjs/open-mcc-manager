import { parseDiscordRetryAfter } from "@open-mcc/contracts/boundary/discord"
import { parseResendErrorName } from "@open-mcc/contracts/boundary/resend"
import type { TelegramReply } from "@open-mcc/contracts/boundary/telegram"

export type DeliveryOutcome =
	| { kind: "delivered"; statusCode: number | undefined }
	| {
			kind: "retryable"
			statusCode: number | undefined
			reason: string
			retryAfterSeconds: number | undefined
	  }
	| { kind: "terminal"; statusCode: number | undefined; reason: string; stopSending: boolean }

export const MAX_RETRY_AFTER_SECONDS = 60 * 60

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504])

export const parseRetryAfter = (value: string | undefined, now: Date): number | undefined => {
	if (value === undefined) return undefined
	const trimmed = value.trim()
	if (trimmed.length === 0) return undefined

	if (/^\d+$/.test(trimmed)) {
		return Math.min(Number(trimmed), MAX_RETRY_AFTER_SECONDS)
	}

	const at = Date.parse(trimmed)
	if (Number.isNaN(at)) return undefined
	const seconds = Math.ceil((at - now.getTime()) / 1000)
	if (seconds <= 0) return 0
	return Math.min(seconds, MAX_RETRY_AFTER_SECONDS)
}

export const classifyHttpStatus = (
	status: number,
	retryAfter?: string,
	now: Date = new Date(),
): DeliveryOutcome => {
	if (status >= 200 && status < 300) return { kind: "delivered", statusCode: status }
	if (status === 410) {
		return {
			kind: "terminal",
			statusCode: status,
			reason: "This destination asked us to stop sending",
			stopSending: true,
		}
	}
	if (RETRYABLE_STATUS.has(status) || status >= 500) {
		return {
			kind: "retryable",
			statusCode: status,
			reason: `Server answered ${status}`,
			retryAfterSeconds: parseRetryAfter(retryAfter, now),
		}
	}
	return {
		kind: "terminal",
		statusCode: status,
		reason: `Server refused with ${status}`,
		stopSending: false,
	}
}

export const classifyNetworkFailure = (reason: string): DeliveryOutcome => ({
	kind: "retryable",
	statusCode: undefined,
	reason,
	retryAfterSeconds: undefined,
})

export const classifyRefusal = (reason: string): DeliveryOutcome => ({
	kind: "terminal",
	statusCode: undefined,
	reason,
	stopSending: false,
})

const TELEGRAM_TERMINAL: ReadonlySet<number> = new Set([400, 401, 403, 404])

export const classifyTelegramReply = (
	httpStatus: number,
	reply: TelegramReply | undefined,
): DeliveryOutcome => {
	if (reply === undefined) return classifyHttpStatus(httpStatus)
	if (reply.ok) return { kind: "delivered", statusCode: httpStatus }

	const code = reply.errorCode ?? httpStatus
	const reason = reply.description ?? `Telegram refused with ${code}`
	const retryAfterSeconds =
		reply.retryAfterSeconds === undefined
			? undefined
			: Math.min(reply.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS)

	if (code === 429) return { kind: "retryable", statusCode: code, reason, retryAfterSeconds }
	if (TELEGRAM_TERMINAL.has(code)) {
		return { kind: "terminal", statusCode: code, reason, stopSending: false }
	}
	return { kind: "retryable", statusCode: code, reason, retryAfterSeconds }
}

const RESEND_QUOTA_SPENT: ReadonlySet<string> = new Set([
	"daily_quota_exceeded",
	"monthly_quota_exceeded",
])

export const classifyDiscordReply = (
	status: number,
	retryAfter: string | undefined,
	body: string,
	now: Date = new Date(),
): DeliveryOutcome => {
	if (status !== 429) return classifyHttpStatus(status, retryAfter, now)
	const fromHeader = parseRetryAfter(retryAfter, now)
	const fromBody = parseDiscordRetryAfter(body)
	const asked = [fromHeader, fromBody].filter((value) => value !== undefined)
	const longest = asked.length === 0 ? undefined : Math.max(...asked)
	return {
		kind: "retryable",
		statusCode: status,
		reason: `Server answered ${status}`,
		retryAfterSeconds:
			longest === undefined ? undefined : Math.min(longest, MAX_RETRY_AFTER_SECONDS),
	}
}

export const classifyResendReply = (
	status: number,
	retryAfter: string | undefined,
	body: string,
	now: Date = new Date(),
): DeliveryOutcome => {
	if (status === 429 && RESEND_QUOTA_SPENT.has(parseResendErrorName(body) ?? "")) {
		return {
			kind: "terminal",
			statusCode: status,
			reason: "The email service has used up its sending quota",
			stopSending: false,
		}
	}
	return classifyHttpStatus(status, retryAfter, now)
}

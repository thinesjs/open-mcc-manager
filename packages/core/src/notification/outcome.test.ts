import { describe, expect, it } from "vitest"
import {
	classifyDiscordReply,
	classifyHttpStatus,
	classifyNetworkFailure,
	classifyResendReply,
	classifyTelegramReply,
	MAX_RETRY_AFTER_SECONDS,
	parseRetryAfter,
} from "./outcome"

describe("deciding whether a failed delivery is worth trying again", () => {
	it("counts any 2xx as delivered", () => {
		expect(classifyHttpStatus(200).kind).toBe("delivered")
		expect(classifyHttpStatus(204).kind).toBe("delivered")
	})

	it("retries the statuses that mean try later", () => {
		for (const status of [408, 429, 500, 502, 503, 504]) {
			expect(classifyHttpStatus(status).kind).toBe("retryable")
		}
	})

	it("gives up on a refusal that will not change on its own", () => {
		for (const status of [400, 401, 403, 404, 410, 422]) {
			expect(classifyHttpStatus(status).kind).toBe("terminal")
		}
	})

	it("retries a network failure, because nothing was refused", () => {
		expect(classifyNetworkFailure("connect timed out").kind).toBe("retryable")
	})
})

describe("telegram, which reports failure inside a 200", () => {
	it("believes the body over the status code", () => {
		const outcome = classifyTelegramReply(200, {
			ok: false,
			errorCode: 403,
			description: "Forbidden: bot was blocked by the user",
			retryAfterSeconds: undefined,
		})

		expect(outcome.kind).toBe("terminal")
	})

	it("treats a genuine ok as delivered", () => {
		expect(
			classifyTelegramReply(200, {
				ok: true,
				errorCode: undefined,
				description: undefined,
				retryAfterSeconds: undefined,
			}).kind,
		).toBe("delivered")
	})

	it("retries when it is being rate limited", () => {
		expect(
			classifyTelegramReply(429, {
				ok: false,
				errorCode: 429,
				description: "Too Many Requests",
				retryAfterSeconds: 30,
			}).kind,
		).toBe("retryable")
	})

	it.each([
		{ code: 400, reason: "Telegram refused the message; check the chat ID" },
		{ code: 401, reason: "Telegram did not accept the bot token" },
		{ code: 403, reason: "The bot may not post in that chat" },
		{ code: 404, reason: "Telegram did not accept the bot token" },
		{ code: 429, reason: "Telegram asked us to slow down" },
		{ code: 502, reason: "Telegram refused with 502" },
	])(
		"★ stores its own words for a $code, and keeps Telegram's words for the log alone",
		({ code, reason }) => {
			const description = "Bad Request: chat 203.0.113.9:8443 not found"
			const outcome = classifyTelegramReply(200, {
				ok: false,
				errorCode: code,
				description,
				retryAfterSeconds: undefined,
			})

			expect(outcome.kind === "delivered" ? undefined : outcome.reason).toBe(reason)
			expect(outcome.kind === "delivered" ? undefined : outcome.detail).toBe(description)
		},
	)

	it("falls back to the status code when the body is unreadable", () => {
		expect(classifyTelegramReply(503, undefined).kind).toBe("retryable")
	})
})

describe("a receiver that asks us to stop", () => {
	it("treats 410 as a standing instruction, not another failure", () => {
		const outcome = classifyHttpStatus(410)
		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.stopSending).toBe(true)
	})

	it("does not disable a destination over a refusal that a person can fix", () => {
		for (const status of [400, 401, 403, 404, 422]) {
			const outcome = classifyHttpStatus(status)
			expect(outcome.kind === "terminal" && outcome.stopSending).toBe(false)
		}
	})
})

describe("honouring Retry-After", () => {
	const now = new Date("2026-09-07T12:00:00Z")

	it("reads a plain number of seconds", () => {
		expect(parseRetryAfter("120", now)).toBe(120)
	})

	it("reads a date and turns it into a wait", () => {
		expect(parseRetryAfter("Mon, 07 Sep 2026 12:02:00 GMT", now)).toBe(120)
	})

	it("treats a date already past as no wait at all", () => {
		expect(parseRetryAfter("Mon, 07 Sep 2026 11:00:00 GMT", now)).toBe(0)
	})

	it("refuses to be parked for a day by a broken server", () => {
		expect(parseRetryAfter("999999", now)).toBe(MAX_RETRY_AFTER_SECONDS)
		expect(parseRetryAfter("Tue, 08 Sep 2026 12:00:00 GMT", now)).toBe(MAX_RETRY_AFTER_SECONDS)
	})

	it("ignores nonsense rather than guessing", () => {
		expect(parseRetryAfter("soon", now)).toBeUndefined()
		expect(parseRetryAfter("", now)).toBeUndefined()
		expect(parseRetryAfter(undefined, now)).toBeUndefined()
	})

	it("carries the wait out of a 429 so the worker can use it", () => {
		const outcome = classifyHttpStatus(429, "45", now)
		expect(outcome.kind === "retryable" && outcome.retryAfterSeconds).toBe(45)
	})

	it("carries the wait out of a Telegram refusal too", () => {
		const outcome = classifyTelegramReply(429, {
			ok: false,
			errorCode: 429,
			description: "Too Many Requests",
			retryAfterSeconds: 30,
		})
		expect(outcome.kind === "retryable" && outcome.retryAfterSeconds).toBe(30)
	})

	it("caps what Telegram asks for, the same as anyone else", () => {
		const outcome = classifyTelegramReply(429, {
			ok: false,
			errorCode: 429,
			description: "Too Many Requests",
			retryAfterSeconds: 999999,
		})
		expect(outcome.kind === "retryable" && outcome.retryAfterSeconds).toBe(MAX_RETRY_AFTER_SECONDS)
	})
})

describe("reading what Discord sends back", () => {
	const now = new Date("2026-09-07T12:00:00.000Z")

	it("reads any 2xx as delivered, because a plain send answers 204 and wait=true answers 200", () => {
		expect(classifyDiscordReply(204, undefined, "", now).kind).toBe("delivered")
		expect(classifyDiscordReply(200, undefined, '{"id":"1"}', now).kind).toBe("delivered")
	})

	it("waits the longer of what the body asked and what the header asked", () => {
		const outcome = classifyDiscordReply(429, "2", '{"retry_after":6.2}', now)
		expect(outcome).toEqual({
			kind: "retryable",
			statusCode: 429,
			reason: "Server answered 429",
			retryAfterSeconds: 7,
		})
	})

	it("still honours the header when the body cannot be read", () => {
		const outcome = classifyDiscordReply(429, "9", "not json", now)
		expect(outcome.kind === "retryable" && outcome.retryAfterSeconds).toBe(9)
	})

	it("still honours the body when there is no header", () => {
		const outcome = classifyDiscordReply(429, undefined, '{"retry_after":0.1}', now)
		expect(outcome.kind === "retryable" && outcome.retryAfterSeconds).toBe(1)
	})

	it("leaves the delay to the backoff when neither source can be read", () => {
		const outcome = classifyDiscordReply(429, undefined, "", now)
		expect(outcome.kind === "retryable" && outcome.retryAfterSeconds).toBeUndefined()
	})

	it("will not be talked into waiting longer than an hour", () => {
		const outcome = classifyDiscordReply(429, undefined, '{"retry_after":99999}', now)
		expect(outcome.kind === "retryable" && outcome.retryAfterSeconds).toBe(MAX_RETRY_AFTER_SECONDS)
	})

	it("treats a malformed payload as terminal", () => {
		const outcome = classifyDiscordReply(400, undefined, '{"code":50109}', now)
		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.stopSending).toBe(false)
	})
})

describe("reading what Resend sends back", () => {
	const now = new Date("2026-09-07T12:00:00.000Z")

	it("retries a rate limit", () => {
		const outcome = classifyResendReply(429, "1", '{"name":"rate_limit_exceeded"}', now)
		expect(outcome.kind).toBe("retryable")
		expect(outcome.kind === "retryable" && outcome.retryAfterSeconds).toBe(1)
	})

	it("gives up on a spent quota, which no number of retries inside the hour can clear", () => {
		for (const name of ["daily_quota_exceeded", "monthly_quota_exceeded"]) {
			const outcome = classifyResendReply(429, undefined, `{"name":"${name}"}`, now)
			expect(outcome.kind).toBe("terminal")
			expect(outcome.kind === "terminal" && outcome.reason).toBe(
				"The email service has used up its sending quota",
			)
			expect(outcome.kind === "terminal" && outcome.stopSending).toBe(false)
		}
	})

	it("falls back to the status line for everything else", () => {
		expect(classifyResendReply(200, undefined, '{"id":"x"}', now).kind).toBe("delivered")
		expect(classifyResendReply(422, undefined, '{"name":"invalid_parameter"}', now).kind).toBe(
			"terminal",
		)
		expect(classifyResendReply(503, undefined, '{"name":"service_unavailable"}', now).kind).toBe(
			"retryable",
		)
		expect(classifyResendReply(429, undefined, "gateway timeout", now).kind).toBe("retryable")
	})
})

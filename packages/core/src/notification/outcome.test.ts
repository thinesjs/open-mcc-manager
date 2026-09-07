import { describe, expect, it } from "vitest"
import {
	classifyHttpStatus,
	classifyNetworkFailure,
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

	it("keeps the reason telegram gave, so an operator can act on it", () => {
		const outcome = classifyTelegramReply(200, {
			ok: false,
			errorCode: 400,
			description: "Bad Request: chat not found",
			retryAfterSeconds: undefined,
		})

		expect(outcome.kind === "terminal" ? outcome.reason : "").toBe("Bad Request: chat not found")
	})

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

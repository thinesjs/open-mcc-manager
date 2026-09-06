import { describe, expect, it } from "vitest"
import { classifyHttpStatus, classifyNetworkFailure, classifyTelegramReply } from "./outcome"

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

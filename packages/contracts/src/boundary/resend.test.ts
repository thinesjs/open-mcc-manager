import { describe, expect, it } from "vitest"
import { parseResendErrorName } from "./resend"

describe("reading which kind of refusal Resend sent", () => {
	it("reads a rate limit apart from a spent quota, because only one is worth retrying", () => {
		expect(
			parseResendErrorName(
				'{"statusCode":429,"name":"rate_limit_exceeded","message":"Too many requests."}',
			),
		).toBe("rate_limit_exceeded")
		expect(
			parseResendErrorName(
				'{"statusCode":429,"name":"daily_quota_exceeded","message":"You have reached your daily limit."}',
			),
		).toBe("daily_quota_exceeded")
	})

	it("refuses a name that is not a string", () => {
		expect(parseResendErrorName('{"name":429}')).toBeUndefined()
		expect(parseResendErrorName('{"name":""}')).toBeUndefined()
	})

	it("refuses a body with no name in it", () => {
		expect(parseResendErrorName('{"message":"something went wrong"}')).toBeUndefined()
	})

	it("refuses a body that is not an object", () => {
		expect(parseResendErrorName('["rate_limit_exceeded"]')).toBeUndefined()
		expect(parseResendErrorName("null")).toBeUndefined()
	})

	it("refuses a body that is not JSON at all", () => {
		expect(parseResendErrorName("Too Many Requests")).toBeUndefined()
	})
})

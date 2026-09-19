import { describe, expect, it } from "vitest"
import { parseDiscordRetryAfter } from "./discord"

describe("reading how long Discord wants us to wait", () => {
	it("rounds a fraction of a second up, because waiting less is a second rate limit", () => {
		expect(
			parseDiscordRetryAfter('{"message":"You are being rate limited.","retry_after":0.25}'),
		).toBe(1)
	})

	it("keeps a whole number as it is", () => {
		expect(parseDiscordRetryAfter('{"retry_after":64.0}')).toBe(64)
	})

	it("accepts zero", () => {
		expect(parseDiscordRetryAfter('{"retry_after":0}')).toBe(0)
	})

	it("refuses a negative delay", () => {
		expect(parseDiscordRetryAfter('{"retry_after":-5}')).toBeUndefined()
	})

	it("refuses a delay that is not finite", () => {
		expect(parseDiscordRetryAfter('{"retry_after":1e999}')).toBeUndefined()
	})

	it("refuses a delay sent as a string", () => {
		expect(parseDiscordRetryAfter('{"retry_after":"12"}')).toBeUndefined()
	})

	it("refuses a delay sent as an object", () => {
		expect(parseDiscordRetryAfter('{"retry_after":{"seconds":12}}')).toBeUndefined()
	})

	it("refuses a body with no delay in it", () => {
		expect(parseDiscordRetryAfter('{"message":"Unknown Webhook","code":10015}')).toBeUndefined()
	})

	it("refuses a body that is not an object", () => {
		expect(parseDiscordRetryAfter("[1,2,3]")).toBeUndefined()
		expect(parseDiscordRetryAfter("null")).toBeUndefined()
		expect(parseDiscordRetryAfter("12")).toBeUndefined()
	})

	it("refuses a body that is not JSON at all", () => {
		expect(parseDiscordRetryAfter("")).toBeUndefined()
		expect(parseDiscordRetryAfter("<html>bad gateway</html>")).toBeUndefined()
	})
})

import { describe, expect, it } from "vitest"
import { readDestinationConfig } from "./destination-config"

describe("reading a destination's stored settings", () => {
	it("reads a webhook with the secret we sign it with", () => {
		const config = readDestinationConfig(
			"webhook",
			'{"url":"https://hooks.example.com/x","signingSecret":"whsec_AAAA"}',
		)
		expect(config?.kind).toBe("webhook")
		expect(config?.kind === "webhook" && config.config.signingSecret).toBe("whsec_AAAA")
	})

	it("refuses a webhook with no secret, so nothing can go out unsigned", () => {
		expect(
			readDestinationConfig("webhook", '{"url":"https://hooks.example.com/x"}'),
		).toBeUndefined()
	})

	it("reads a Telegram destination with a topic", () => {
		const config = readDestinationConfig(
			"telegram",
			'{"botToken":"123:AAA","chatId":"-1001","messageThreadId":9}',
		)
		expect(config?.kind).toBe("telegram")
	})

	it("gives up rather than guessing when the stored value is not settings we understand", () => {
		for (const [kind, sealed] of [
			["webhook", "not json"],
			["webhook", "null"],
			["webhook", "[]"],
			["webhook", "{}"],
			["webhook", '{"url":"not a url","signingSecret":"whsec_AAAA"}'],
			["telegram", '{"botToken":"123:AAA"}'],
			["telegram", '{"botToken":"123:AAA","chatId":"-1","messageThreadId":"9"}'],
			["nonsense", '{"url":"https://hooks.example.com/x"}'],
		]) {
			expect(readDestinationConfig(kind ?? "", sealed ?? "")).toBeUndefined()
		}
	})
})

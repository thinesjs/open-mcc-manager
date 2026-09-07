import { describe, expect, it } from "vitest"
import { parseTelegramReply } from "./telegram"

describe("reading what Telegram sends back", () => {
	it("reads a success", () => {
		expect(parseTelegramReply('{"ok":true,"result":{"message_id":7}}')).toEqual({
			ok: true,
			errorCode: undefined,
			description: undefined,
			retryAfterSeconds: undefined,
		})
	})

	it("reads a refusal, which Telegram sends inside a 200", () => {
		expect(
			parseTelegramReply('{"ok":false,"error_code":400,"description":"chat not found"}'),
		).toEqual({
			ok: false,
			errorCode: 400,
			description: "chat not found",
			retryAfterSeconds: undefined,
		})
	})

	it("picks up how long it wants us to wait", () => {
		const reply = parseTelegramReply(
			'{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":31}}',
		)
		expect(reply?.retryAfterSeconds).toBe(31)
	})

	it("gives up on anything that is not a reply we understand", () => {
		for (const raw of [
			"",
			"not json",
			"[]",
			"null",
			'"ok"',
			"{}",
			'{"ok":"yes"}',
			'{"result":true}',
		]) {
			expect(parseTelegramReply(raw)).toBeUndefined()
		}
	})

	it("ignores fields of the wrong shape rather than trusting them", () => {
		const reply = parseTelegramReply(
			'{"ok":false,"error_code":"400","description":42,"parameters":{"retry_after":"soon"}}',
		)
		expect(reply).toEqual({
			ok: false,
			errorCode: undefined,
			description: undefined,
			retryAfterSeconds: undefined,
		})
	})

	it("survives a body that is huge or oddly nested without throwing", () => {
		expect(parseTelegramReply(`{"ok":true,"result":${"[".repeat(50)}${"]".repeat(50)}}`)).toEqual({
			ok: true,
			errorCode: undefined,
			description: undefined,
			retryAfterSeconds: undefined,
		})
	})
})

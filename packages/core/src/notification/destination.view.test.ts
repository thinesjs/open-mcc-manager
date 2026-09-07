import { describe, expect, it } from "vitest"
import { maskedChatId, shortFingerprint, telegramTarget, webhookTarget } from "./destination.view"

describe("showing where a destination points without giving it away", () => {
	it("shows a webhook's host but never its secret path", () => {
		const target = webhookTarget("https://hooks.example.com/services/T00/B00/SECRET")
		expect(target).toContain("https://hooks.example.com")
		expect(target).not.toContain("SECRET")
		expect(target).not.toContain("T00")
	})

	it("reads the same for two webhooks on one host, which is why the mark exists separately", () => {
		expect(webhookTarget("https://hooks.example.com/services/AAA")).toBe(
			webhookTarget("https://hooks.example.com/services/BBB"),
		)
		expect(shortFingerprint("https://hooks.example.com/services/AAA")).not.toBe(
			shortFingerprint("https://hooks.example.com/services/BBB"),
		)
	})

	it("gives the same webhook the same mark every time", () => {
		expect(shortFingerprint("https://hooks.example.com/a")).toBe(
			shortFingerprint("https://hooks.example.com/a"),
		)
	})

	it("keeps the mark out of the address, so it is not shown when nothing needs telling apart", () => {
		expect(webhookTarget("https://hooks.example.com/services/AAA")).toBe(
			"https://hooks.example.com/…",
		)
	})

	it("cannot be turned back into the path it came from", () => {
		const mark = shortFingerprint("https://hooks.example.com/services/SECRET")
		expect(mark).toHaveLength(6)
		expect(mark).not.toContain("SECRET")
	})

	it("shows enough of a Telegram chat to recognise it, and no more", () => {
		expect(telegramTarget("-1001234567890", undefined)).toBe("Telegram, chat …7890")
		expect(maskedChatId("-1001234567890")).not.toContain("100123")
	})

	it("names the topic when there is one, because two alerts can share a chat", () => {
		expect(telegramTarget("-1001234567890", 42)).toBe("Telegram, chat …7890, topic 42")
	})

	it("does not fall apart on a very short chat id", () => {
		expect(maskedChatId("12")).toBe("chat …12")
	})
})

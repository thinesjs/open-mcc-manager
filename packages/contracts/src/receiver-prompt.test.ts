import { describe, expect, it } from "vitest"
import {
	CURSOR_DEEPLINK_LIMIT,
	claudeDesktopDeeplink,
	cursorDeeplink,
	RECEIVER_SECRET_ENV,
	receiverPrompt,
	withinDeeplinkLimit,
} from "./receiver-prompt"

const prompt = receiverPrompt()

describe("the prompt handed to an AI tool", () => {
	it("names the environment variable rather than any real key", () => {
		expect(prompt).toContain(RECEIVER_SECRET_ENV)
		expect(prompt).not.toContain("whsec_M")
	})

	it("states the mistake that breaks verification: signing with the string instead of the bytes", () => {
		expect(prompt).toContain("base64-DECODED")
		expect(prompt).toContain("not with the prefixed string")
	})

	it("insists on the raw body, because re-serialising the JSON changes the signature", () => {
		expect(prompt).toContain("RAW REQUEST BODY BYTES")
	})

	it("asks for the things a receiver is usually missing", () => {
		expect(prompt).toContain("constant time")
		expect(prompt).toContain("replayed")
		expect(prompt).toContain("idempotency key")
		expect(prompt).toContain("rotation")
	})

	it("explains what each response code means to the sender", () => {
		expect(prompt).toContain("will retry")
	})

	it("asks for a tampered-body test, not just a happy path", () => {
		expect(prompt).toContain("tampers with the body")
	})
})

describe("the deeplinks", () => {
	it("fits inside the length a deeplink allows", () => {
		expect(withinDeeplinkLimit(cursorDeeplink(prompt))).toBe(true)
		expect(cursorDeeplink(prompt).length).toBeLessThan(CURSOR_DEEPLINK_LIMIT)
	})

	it("encodes the prompt so newlines and quotes survive the URL", () => {
		const url = cursorDeeplink(prompt)
		expect(url).not.toContain("\n")
		expect(url).toContain("%0A")
	})

	it("opens a composer rather than running anything", () => {
		expect(cursorDeeplink(prompt).startsWith("https://cursor.com/link/prompt?text=")).toBe(true)
		expect(claudeDesktopDeeplink(prompt).startsWith("claude://claude.ai/new?q=")).toBe(true)
	})

	it("says no when a prompt would be too long to carry", () => {
		expect(withinDeeplinkLimit(cursorDeeplink("x".repeat(9000)))).toBe(false)
	})
})

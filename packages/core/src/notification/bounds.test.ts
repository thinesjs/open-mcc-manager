import { describe, expect, it } from "vitest"
import { byteLength, truncateBytes, truncateChars } from "./bounds"

describe("keeping a message inside what a provider will take", () => {
	it("leaves text that already fits alone", () => {
		expect(truncateChars("short", 10)).toBe("short")
		expect(truncateBytes("short", 10)).toBe("short")
	})

	it("cuts to the limit and says it cut", () => {
		expect(truncateChars("abcdefghij", 5)).toBe("abcd…")
		expect(truncateChars("abcdefghij", 5)).toHaveLength(5)
	})

	it("counts an emoji as one character rather than two", () => {
		expect(truncateChars("🎮🎮🎮", 3)).toBe("🎮🎮🎮")
		expect(truncateChars("🎮🎮🎮", 2)).toBe("🎮…")
	})

	it("never leaves half of a multi-byte character at the cut", () => {
		const cut = truncateBytes("aaa€€€", 8)
		expect(byteLength(cut)).toBeLessThanOrEqual(8)
		expect(cut).toBe("aaa…")
		expect(Buffer.from(cut, "utf8").toString("utf8")).toBe(cut)
	})

	it("stays inside a byte budget even when every character is wide", () => {
		const cut = truncateBytes("€".repeat(100), 20)
		expect(byteLength(cut)).toBeLessThanOrEqual(20)
		expect(cut.endsWith("…")).toBe(true)
	})

	it("keeps content rather than emitting a lone marker at the tightest budget", () => {
		expect(truncateBytes("abcdef", 3)).toBe("abc")
		expect(byteLength(truncateBytes("abcdef", 3))).toBe(3)
	})

	it("drops the marker when there is no room for it", () => {
		expect(truncateBytes("abcdef", 2)).toBe("ab")
		expect(truncateChars("abcdef", 1)).toBe("a")
		expect(truncateChars("abcdef", 0)).toBe("")
	})
})

import { describe, expect, it } from "vitest"
import { BOTTOM_THRESHOLD_PX, distanceFromBottom, isAtBottom } from "./scroll"

describe("isAtBottom", () => {
	it("counts an exactly-scrolled view as at the bottom", () => {
		expect(isAtBottom({ scrollTop: 400, scrollHeight: 800, clientHeight: 400 })).toBe(true)
	})

	it("tolerates the sub-pixel gap a browser leaves after scrolling", () => {
		expect(isAtBottom({ scrollTop: 399.6, scrollHeight: 800, clientHeight: 400 })).toBe(true)
	})

	it("treats a reader who scrolled up as not at the bottom", () => {
		expect(isAtBottom({ scrollTop: 100, scrollHeight: 800, clientHeight: 400 })).toBe(false)
	})

	it("counts a view shorter than its container as at the bottom", () => {
		expect(isAtBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(true)
	})

	it("measures how far from the bottom the reader is", () => {
		expect(distanceFromBottom({ scrollTop: 100, scrollHeight: 800, clientHeight: 400 })).toBe(300)
	})

	it("lets the threshold be widened", () => {
		const metrics = { scrollTop: 350, scrollHeight: 800, clientHeight: 400 }

		expect(isAtBottom(metrics)).toBe(false)
		expect(isAtBottom(metrics, 60)).toBe(true)
		expect(BOTTOM_THRESHOLD_PX).toBe(24)
	})
})

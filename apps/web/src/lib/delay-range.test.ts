import { describe, expect, it } from "vitest"
import { formatDelaySeconds } from "./delay-range"

describe("showing a delay range", () => {
	it("shows one number when an operator wants no jitter", () => {
		expect(formatDelaySeconds({ min: 10, max: 10 })).toBe("10s")
	})

	it("shows both bounds when they differ, never the object itself", () => {
		expect(formatDelaySeconds({ min: 5, max: 20 })).toBe("5-20s")
	})
})

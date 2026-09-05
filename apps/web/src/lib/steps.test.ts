import { describe, expect, it } from "vitest"
import { clampStep, directionBetween, isLastStep } from "./steps"

describe("moving between steps", () => {
	it("never walks past either end", () => {
		expect(clampStep(-1, 4)).toBe(0)
		expect(clampStep(9, 4)).toBe(3)
		expect(clampStep(2, 4)).toBe(2)
	})

	it("knows which way the content should travel", () => {
		expect(directionBetween(0, 1)).toBe(1)
		expect(directionBetween(2, 1)).toBe(-1)
	})

	it("treats staying put as forward, so a repeat does not slide backwards", () => {
		expect(directionBetween(1, 1)).toBe(1)
	})

	it("knows when the last step is reached", () => {
		expect(isLastStep(3, 4)).toBe(true)
		expect(isLastStep(2, 4)).toBe(false)
	})
})

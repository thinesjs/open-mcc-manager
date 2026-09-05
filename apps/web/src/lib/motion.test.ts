import { describe, expect, it } from "vitest"
import { durationFor, variantsFor } from "./motion"

describe("respecting a reduced-motion preference", () => {
	it("moves and blurs when the visitor has expressed no preference", () => {
		const { hidden, visible } = variantsFor(false)
		expect(hidden.scale).toBeLessThan(1)
		expect(hidden.filter).toContain("blur")
		expect(visible.scale).toBe(1)
	})

	it("changes only opacity when the visitor asked for reduced motion", () => {
		const { hidden, visible } = variantsFor(true)
		expect(hidden.scale).toBeUndefined()
		expect(hidden.filter).toBeUndefined()
		expect(visible.scale).toBeUndefined()
		expect(hidden.opacity).toBe(0)
		expect(visible.opacity).toBe(1)
	})

	it("still fades rather than cutting, because motion off is not meaning off", () => {
		expect(variantsFor(true).visible.opacity).toBe(1)
		expect(durationFor(true, 0.4)).toBeGreaterThan(0)
	})

	it("shortens durations under reduced motion without removing them", () => {
		expect(durationFor(true, 0.4)).toBeLessThanOrEqual(0.1)
		expect(durationFor(false, 0.4)).toBe(0.4)
	})
})

import { EMPTY_AVAILABILITY } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import { describeCoverage, describeUptime, formatPercent } from "./uptime"

describe("saying how much of the time OpenMCC could reach something", () => {
	it("says so plainly when nothing has been measured yet", () => {
		expect(describeUptime(EMPTY_AVAILABILITY)).toBe("Not measured yet")
	})

	it("never rounds a real outage up to a clean hundred per cent", () => {
		expect(formatPercent(0.999)).toBe("99.90%")
		expect(formatPercent(0.9994)).toBe("99.94%")
	})

	it("reserves 100% for something genuinely unbroken", () => {
		expect(formatPercent(1)).toBe("100%")
	})

	it("never shows 100% while there was any bad time at all", () => {
		expect(formatPercent(1 - 30 / 86_400)).toBe("99.96%")
		expect(formatPercent(1 - 1e-12)).toBe("99.99%")
	})

	it("floors to two decimals without losing a hundredth to rounding error", () => {
		expect(formatPercent(57 / 100)).toBe("57.00%")
		expect(formatPercent(1 / 3)).toBe("33.33%")
	})

	it("mentions coverage only when there is a gap worth admitting", () => {
		expect(describeCoverage({ ...EMPTY_AVAILABILITY, goodSeconds: 100 })).toBeUndefined()
		expect(describeCoverage({ ...EMPTY_AVAILABILITY, goodSeconds: 50, unknownSeconds: 50 })).toBe(
			"Measured 50.00% of the time",
		)
	})
})

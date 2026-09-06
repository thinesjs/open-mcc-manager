import { EMPTY_AVAILABILITY } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import { verdictFor } from "./uptime-bars"

const day = (patch: Partial<typeof EMPTY_AVAILABILITY>) => ({
	start: "2026-09-06T00:00:00.000Z",
	availability: { ...EMPTY_AVAILABILITY, ...patch },
})

describe("what colour a day gets", () => {
	it("shows a day with no measurements as blank, not as good", () => {
		expect(verdictFor(day({}))).toBe("none")
		expect(verdictFor(day({ unknownSeconds: 86_400 }))).toBe("none")
	})

	it("shows a fully reachable day as good", () => {
		expect(verdictFor(day({ goodSeconds: 86_400 }))).toBe("good")
	})

	it("shows a day with a short outage as partial rather than hiding it", () => {
		expect(verdictFor(day({ goodSeconds: 86_000, badSeconds: 400 }))).toBe("partial")
	})

	it("shows a badly broken day as bad", () => {
		expect(verdictFor(day({ goodSeconds: 40_000, badSeconds: 46_400 }))).toBe("bad")
	})

	it("does not let excluded time turn an unmeasured day green", () => {
		expect(verdictFor(day({ excludedSeconds: 86_400 }))).toBe("none")
	})
})

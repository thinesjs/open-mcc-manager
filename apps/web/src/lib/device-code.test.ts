import { describe, expect, it } from "vitest"
import { describeCodeValidity } from "./device-code"

const NOW = Date.parse("2026-09-14T12:00:00.000Z")

const inMs = (ms: number): string => new Date(NOW + ms).toISOString()

describe("how long a sign-in code stays valid", () => {
	it("reads a fresh code's whole lifetime", () => {
		expect(describeCodeValidity(inMs(15 * 60_000), NOW)).toBe("Valid for 15 more minutes.")
	})

	it("counts a part minute as a minute, so it never says less time than is left", () => {
		expect(describeCodeValidity(inMs(14 * 60_000 + 1), NOW)).toBe("Valid for 15 more minutes.")
	})

	it("says the last minute in the singular", () => {
		expect(describeCodeValidity(inMs(30_000), NOW)).toBe("Valid for 1 more minute.")
	})

	it("says the code has expired once its time is up", () => {
		expect(describeCodeValidity(inMs(0), NOW)).toBe("This code has expired. Get a new one.")
	})
})

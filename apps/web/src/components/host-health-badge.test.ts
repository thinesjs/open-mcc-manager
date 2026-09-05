import { describe, expect, it } from "vitest"
import { healthOf } from "./host-health-badge"

const NOW = new Date("2026-09-06T12:00:00Z")

describe("showing whether a host is up", () => {
	it("accepts the string date the api sends over the wire", () => {
		expect(
			healthOf({ status: "ready", lastSeenAt: "2026-09-06T11:59:55.000Z", failedUnits: 0 }, NOW),
		).toBe("online")
	})

	it("marks a host abnormal when something on it has failed", () => {
		expect(
			healthOf({ status: "ready", lastSeenAt: "2026-09-06T11:59:55.000Z", failedUnits: 1 }, NOW),
		).toBe("degraded")
	})

	it("marks a host offline once its last answer is old", () => {
		expect(
			healthOf({ status: "ready", lastSeenAt: "2026-09-06T11:00:00.000Z", failedUnits: 0 }, NOW),
		).toBe("offline")
	})

	it("says it has not been reached rather than claiming it is down", () => {
		expect(healthOf({ status: "ready", lastSeenAt: null, failedUnits: null }, NOW)).toBe("unknown")
	})
})

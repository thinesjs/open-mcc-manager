import { describe, expect, it } from "vitest"
import {
	type Availability,
	coverageRatio,
	EMPTY_AVAILABILITY,
	isNotifyingEvent,
	measuredSeconds,
	uptimeRatio,
} from "./status"

const availability = (patch: Partial<Availability>): Availability => ({
	...EMPTY_AVAILABILITY,
	...patch,
})

describe("uptime", () => {
	it("refuses to report uptime when nothing was measured", () => {
		expect(uptimeRatio(EMPTY_AVAILABILITY)).toBeUndefined()
	})

	it("refuses to report uptime from unknown time alone, so a gap cannot read as healthy", () => {
		expect(uptimeRatio(availability({ unknownSeconds: 3_600 }))).toBeUndefined()
	})

	it("counts a full measured hour of good time as one", () => {
		expect(uptimeRatio(availability({ goodSeconds: 3_600 }))).toBe(1)
	})

	it("leaves unknown time out of the uptime denominator", () => {
		const ratio = uptimeRatio(
			availability({ goodSeconds: 900, badSeconds: 100, unknownSeconds: 9_000 }),
		)

		expect(ratio).toBeCloseTo(0.9, 5)
	})

	it("treats degraded time as up, because a reachable host with a failed service is still reachable", () => {
		expect(uptimeRatio(availability({ goodSeconds: 100, degradedSeconds: 100 }))).toBe(1)
	})

	it("leaves excluded time out entirely, so a sleep window is neither up nor down", () => {
		expect(uptimeRatio(availability({ goodSeconds: 100, excludedSeconds: 9_000 }))).toBe(1)
		expect(measuredSeconds(availability({ goodSeconds: 100, excludedSeconds: 9_000 }))).toBe(100)
	})
})

describe("coverage", () => {
	it("is undefined when there was nothing observable at all", () => {
		expect(coverageRatio(EMPTY_AVAILABILITY)).toBeUndefined()
	})

	it("falls as unknown time grows, which is what stops a gap reading as 100 per cent", () => {
		expect(coverageRatio(availability({ goodSeconds: 50, unknownSeconds: 50 }))).toBe(0.5)
	})

	it("is complete when every second was observed", () => {
		expect(coverageRatio(availability({ goodSeconds: 30, badSeconds: 70 }))).toBe(1)
	})

	it("ignores excluded time, so a sleep window does not look like a monitoring gap", () => {
		expect(coverageRatio(availability({ goodSeconds: 100, excludedSeconds: 500 }))).toBe(1)
	})
})

describe("which events are worth waking someone for", () => {
	it("notifies on a sustained outage and its recovery", () => {
		expect(isNotifyingEvent("host.unreachable")).toBe(true)
		expect(isNotifyingEvent("instance.disconnected")).toBe(true)
		expect(isNotifyingEvent("instance.reconnected")).toBe(true)
	})

	it("stays quiet for a single kick, because the client is configured to rejoin", () => {
		expect(isNotifyingEvent("instance.kicked")).toBe(false)
		expect(isNotifyingEvent("instance.connection_lost")).toBe(false)
		expect(isNotifyingEvent("host.check_failed")).toBe(false)
	})

	it("notifies when a sign-in is needed, because nothing retries that on its own", () => {
		expect(isNotifyingEvent("instance.needs_auth")).toBe(true)
	})

	it("stays quiet for an ordinary start or stop", () => {
		expect(isNotifyingEvent("instance.started")).toBe(false)
		expect(isNotifyingEvent("instance.stopped")).toBe(false)
	})
})

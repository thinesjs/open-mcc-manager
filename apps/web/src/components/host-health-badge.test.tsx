import { HOST_HEALTH } from "@open-mcc/contracts"
import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HostHealthBadge, type HostHealthInput, healthOf } from "./host-health-badge"

const NOW = new Date("2026-09-06T12:00:00Z")

const JUST_ANSWERED = "2026-09-06T11:59:55.000Z"

const LONG_AGO = "2026-09-06T11:00:00.000Z"

const SHOWING: Record<(typeof HOST_HEALTH)[number], HostHealthInput> = {
	online: { status: "ready", lastSeenAt: JUST_ANSWERED, failedUnits: 0 },
	degraded: { status: "ready", lastSeenAt: JUST_ANSWERED, failedUnits: 1 },
	unreadable: { status: "ready", lastSeenAt: JUST_ANSWERED, failedUnits: null },
	offline: { status: "ready", lastSeenAt: LONG_AGO, failedUnits: 0 },
	unknown: { status: "ready", lastSeenAt: null, failedUnits: null },
}

const labelFor = (host: HostHealthInput): string =>
	render(<HostHealthBadge host={host} />).container.textContent ?? ""

describe("showing whether a host is up", () => {
	it("accepts the string date the api sends over the wire", () => {
		expect(healthOf(SHOWING.online, NOW)).toBe("online")
	})

	it("marks a host abnormal when something on it has failed", () => {
		expect(healthOf(SHOWING.degraded, NOW)).toBe("degraded")
	})

	it("marks a host offline once its last answer is old", () => {
		expect(healthOf(SHOWING.offline, NOW)).toBe("offline")
	})

	it("says it has not been reached rather than claiming it is down", () => {
		expect(healthOf(SHOWING.unknown, NOW)).toBe("unknown")
	})

	it("does not claim a host is fine while its failed units are unknown", () => {
		expect(healthOf(SHOWING.unreadable, NOW)).toBe("unreadable")
	})
})

describe("what the badge tells an operator", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
	})

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
	})

	it("gives each state its own words, so none is read as another", () => {
		const labels = HOST_HEALTH.map((health) => labelFor(SHOWING[health]))

		expect(new Set(labels).size).toBe(HOST_HEALTH.length)
	})

	it("says what it could not do, rather than a state it did not observe", () => {
		const label = labelFor(SHOWING.unreadable)

		expect(label).toBe("Not readable")
		expect(label).not.toMatch(/online|offline|degraded|reached/i)
	})
})

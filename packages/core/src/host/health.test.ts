import { describe, expect, it } from "vitest"
import { failedUnitsCommand, healthFor, OFFLINE_AFTER_MS, parseFailedUnits } from "./health"
import { rootlessProfile, systemProfile } from "./profile"

const NOW = new Date("2026-09-06T12:00:00Z")
const secondsAgo = (ms: number) => new Date(NOW.getTime() - ms)

describe("deciding whether a host is up", () => {
	it("says online when it answered recently and nothing has failed", () => {
		expect(healthFor({ status: "ready", lastSeenAt: secondsAgo(5_000), failedUnits: 0 }, NOW)).toBe(
			"online",
		)
	})

	it("says degraded when it answers but something on it has failed", () => {
		expect(healthFor({ status: "ready", lastSeenAt: secondsAgo(5_000), failedUnits: 2 }, NOW)).toBe(
			"degraded",
		)
	})

	it("says offline once it has stopped answering for long enough", () => {
		expect(
			healthFor(
				{ status: "ready", lastSeenAt: secondsAgo(OFFLINE_AFTER_MS + 1_000), failedUnits: 0 },
				NOW,
			),
		).toBe("offline")
	})

	it("tolerates a single missed poll rather than flapping to offline", () => {
		expect(
			healthFor(
				{ status: "ready", lastSeenAt: secondsAgo(OFFLINE_AFTER_MS - 1_000), failedUnits: 0 },
				NOW,
			),
		).toBe("online")
	})

	it("says unknown for a host that is not expected to be up yet", () => {
		expect(healthFor({ status: "pending", lastSeenAt: null, failedUnits: null }, NOW)).toBe(
			"unknown",
		)
		expect(healthFor({ status: "provisioning", lastSeenAt: null, failedUnits: null }, NOW)).toBe(
			"unknown",
		)
	})

	it("says unknown, not online, for a ready host it has never reached", () => {
		expect(healthFor({ status: "ready", lastSeenAt: null, failedUnits: null }, NOW)).toBe("unknown")
	})

	it("trusts a recorded failure over a stale successful poll", () => {
		expect(
			healthFor({ status: "unreachable", lastSeenAt: secondsAgo(1_000), failedUnits: 0 }, NOW),
		).toBe("offline")
	})
})

describe("counting what has failed on a host", () => {
	it("asks the manager that actually owns the units", () => {
		expect(failedUnitsCommand(rootlessProfile("/home/u"))).toContain("--user")
		expect(failedUnitsCommand(systemProfile())).not.toContain("--user")
	})

	it("asks only about units this control plane installed", () => {
		expect(failedUnitsCommand(systemProfile())).toContain("'open-mcc*'")
	})

	it("reads a count, and treats anything unreadable as nothing failed", () => {
		expect(parseFailedUnits("3")).toBe(3)
		expect(parseFailedUnits("0")).toBe(0)
		expect(parseFailedUnits("")).toBe(0)
		expect(parseFailedUnits("not a number")).toBe(0)
	})
})

import { describe, expect, it } from "vitest"
import { nextReachability, type ReachabilityCurrent, UNOBSERVED } from "./reachability"

const at = (minutes: number): Date => new Date(Date.UTC(2026, 0, 1, 0, minutes, 0))

const state = (patch: Partial<ReachabilityCurrent>): ReachabilityCurrent => ({
	...UNOBSERVED,
	...patch,
})

describe("host reachability", () => {
	it("does not call a host down on one failed check", () => {
		const decision = nextReachability(state({ state: "up" }), false, at(0))

		expect(decision.state).toBe("suspect")
		expect(decision.event).toBe("host.check_failed")
	})

	it("only calls it down once failure has lasted three minutes", () => {
		const suspect = state({ state: "suspect", failureStartedAt: at(0) })

		expect(nextReachability(suspect, false, at(2)).state).toBe("suspect")
		expect(nextReachability(suspect, false, at(3)).state).toBe("down")
		expect(nextReachability(suspect, false, at(3)).event).toBe("host.unreachable")
	})

	it("keeps the original failure time when it escalates, so downtime is not shortened", () => {
		const suspect = state({ state: "suspect", failureStartedAt: at(0) })

		expect(nextReachability(suspect, false, at(5)).failureStartedAt).toEqual(at(0))
	})

	it("raises the outage once and stays quiet while it continues", () => {
		const down = state({ state: "down", failureStartedAt: at(0) })
		const decision = nextReachability(down, false, at(30))

		expect(decision.event).toBeUndefined()
		expect(decision.changed).toBe(false)
	})

	it("distinguishes a real recovery from a blip that never became an outage", () => {
		expect(nextReachability(state({ state: "down" }), true, at(9)).event).toBe("host.recovered")
		expect(nextReachability(state({ state: "suspect" }), true, at(9)).event).toBe(
			"host.check_recovered",
		)
	})

	it("says nothing while a healthy host stays healthy", () => {
		const decision = nextReachability(state({ state: "up" }), true, at(9))

		expect(decision.event).toBeUndefined()
		expect(decision.changed).toBe(false)
	})

	it("treats a never-before-seen host reaching as a change worth recording", () => {
		const decision = nextReachability(UNOBSERVED, true, at(0))

		expect(decision.state).toBe("up")
		expect(decision.changed).toBe(true)
	})

	it("does not call a first sighting a recovery, because nothing was ever wrong", () => {
		expect(nextReachability(UNOBSERVED, true, at(0)).event).toBeUndefined()
	})

	it("clears the failure clock on recovery so the next outage times from scratch", () => {
		expect(
			nextReachability(state({ state: "down", failureStartedAt: at(0) }), true, at(9))
				.failureStartedAt,
		).toBeNull()
	})
})

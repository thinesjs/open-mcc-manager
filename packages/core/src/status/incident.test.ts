import { describe, expect, it } from "vitest"
import {
	countsAsLoss,
	escalationKeyFor,
	incidentOfEvent,
	lossWindow,
	nextIncident,
	worthClaimingFlapping,
} from "./incident"

let counter = 0
const fresh = () => `inc_${++counter}`

describe("when an incident opens and closes", () => {
	it("opens on the first loss and gets an id", () => {
		const decision = nextIncident(null, "interrupted", "instance.connection_lost", fresh)
		expect(decision.opened).toBe(true)
		expect(decision.incidentId).not.toBeNull()
	})

	it("keeps the same incident across further losses, rather than starting a new one", () => {
		const decision = nextIncident("inc_a", "interrupted", "instance.kicked", fresh)
		expect(decision.incidentId).toBe("inc_a")
		expect(decision.opened).toBe(false)
	})

	it("closes when the bot gets back on", () => {
		expect(nextIncident("inc_a", "joined", "instance.reconnected", fresh).incidentId).toBeNull()
		expect(nextIncident("inc_a", "joined", "instance.joined", fresh).incidentId).toBeNull()
	})

	it("keeps the incident open when the bot escalates to down, because it is still not back", () => {
		expect(nextIncident("inc_a", "down", "instance.disconnected", fresh).incidentId).toBe("inc_a")
	})

	it("carries nothing forward when there was nothing open", () => {
		expect(nextIncident(null, "down", "instance.stopped", fresh).incidentId).toBeNull()
	})
})

describe("the key that stops an escalation happening twice", () => {
	it("is the same for the same incident, however many jobs run", () => {
		expect(escalationKeyFor("inc_a")).toBe(escalationKeyFor("inc_a"))
	})

	it("differs between incidents, so a later outage still alerts", () => {
		expect(escalationKeyFor("inc_a")).not.toBe(escalationKeyFor("inc_b"))
	})
})

describe("what counts as a drop for flapping", () => {
	it("counts a lost connection and a kick, which is the owner's rule", () => {
		expect(countsAsLoss("instance.connection_lost")).toBe(true)
		expect(countsAsLoss("instance.kicked")).toBe(true)
	})

	it("counts nothing else", () => {
		for (const event of [
			"instance.joined",
			"instance.reconnected",
			"instance.stopped",
			"instance.disconnected",
			"instance.flapping",
			undefined,
		] as const) {
			expect(countsAsLoss(event)).toBe(false)
		}
	})
})

describe("counting drops from what the database already holds", () => {
	const at = new Date("2026-09-07T12:00:00Z")
	const drops = (count: number) =>
		Array.from({ length: count }, (_, index) => new Date(at.getTime() - index * 2 * 60_000))

	it("does not raise flapping on four drops, because the current one is already among them", () => {
		expect(worthClaimingFlapping(drops(4), at)).toBe(false)
	})

	it("raises it on the fifth", () => {
		expect(worthClaimingFlapping(drops(5), at)).toBe(true)
	})

	it("asks for a bounded window, so a drop after the event cannot be counted", () => {
		const window = lossWindow(at)

		expect(window.until).toEqual(at)
		expect(window.since.getTime()).toBe(at.getTime() - 30 * 60_000)
	})

	it("takes a shorter window when asked", () => {
		expect(lossWindow(at, 60_000).since.getTime()).toBe(at.getTime() - 60_000)
	})
})

describe("which incident an event belongs to", () => {
	it("gives a recovery the incident it is closing, not nothing", () => {
		const decision = nextIncident("inc_a", "joined", "instance.reconnected", fresh)

		expect(decision.incidentId).toBeNull()
		expect(decision.closing).toBe("inc_a")
		expect(incidentOfEvent(decision)).toBe("inc_a")
	})

	it("gives a loss the incident it opened", () => {
		const decision = nextIncident(null, "interrupted", "instance.connection_lost", fresh)

		expect(incidentOfEvent(decision)).toBe(decision.incidentId)
		expect(incidentOfEvent(decision)).not.toBeNull()
	})

	it("gives a continuing loss the incident already open", () => {
		expect(incidentOfEvent(nextIncident("inc_a", "interrupted", "instance.kicked", fresh))).toBe(
			"inc_a",
		)
	})

	it("has nothing to attribute when nothing was open and nothing opened", () => {
		expect(incidentOfEvent(nextIncident(null, "down", "instance.stopped", fresh))).toBeNull()
	})

	it("keeps the incident through an escalation, because the outage continues", () => {
		expect(incidentOfEvent(nextIncident("inc_a", "down", "instance.disconnected", fresh))).toBe(
			"inc_a",
		)
	})
})

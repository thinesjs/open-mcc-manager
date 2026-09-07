import { isFlapping, RESOLVING_EVENT_KINDS, STATUS_EVENT_KINDS } from "@open-mcc/contracts"
import { describe, expect, it, vi } from "vitest"
import {
	dedupeKeyFor,
	type EventFact,
	planNotification,
	relevantKinds,
	worthAnnouncing,
} from "./producer"

const fact = (over: Partial<EventFact> = {}): EventFact => ({
	statusEventId: "evt_1",
	kind: "host.unreachable",
	subjectType: "host",
	subjectId: "host_1",
	subjectName: "basement-box",
	...over,
})

const never = async () => undefined

describe("which events are worth a message", () => {
	it("sends the problems an operator asked to hear about", () => {
		for (const kind of [
			"host.unreachable",
			"host.drift_started",
			"instance.disconnected",
			"instance.flapping",
			"instance.never_joined",
			"instance.unexpected_stop",
			"instance.needs_auth",
			"instance.drift_started",
		] as const) {
			expect(worthAnnouncing(kind, undefined)).toBe(true)
		}
	})

	it("stays quiet for a kick, because the bot is supposed to just come back", async () => {
		expect(worthAnnouncing("instance.kicked", undefined)).toBe(false)
		expect(await planNotification(fact({ kind: "instance.kicked" }), never)).toBeUndefined()
	})

	it("stays quiet for the ordinary run of events", async () => {
		for (const kind of [
			"instance.joined",
			"instance.started",
			"instance.stopped",
			"host.check_failed",
			"host.check_recovered",
			"host.degraded",
			"host.healthy",
			"instance.connection_lost",
			"monitoring.gap",
		] as const) {
			expect(await planNotification(fact({ kind }), never)).toBeUndefined()
		}
	})
})

describe("a recovery only speaks if its problem did", () => {
	it("announces the recovery when the problem was announced", async () => {
		const lastAnnounced = vi.fn(async () => "instance.disconnected")
		const planned = await planNotification(
			fact({ kind: "instance.reconnected", subjectType: "instance", subjectId: "i1" }),
			lastAnnounced,
		)

		expect(planned?.kind).toBe("instance.reconnected")
		expect(lastAnnounced).toHaveBeenCalledWith(
			"instance",
			"i1",
			["instance.disconnected", "instance.reconnected"],
			undefined,
		)
	})

	it("says nothing when the problem was never announced, so a quiet kick's rejoin cannot page", async () => {
		expect(
			await planNotification(fact({ kind: "instance.reconnected" }), async () => undefined),
		).toBeUndefined()
	})

	it("says nothing twice, when the last thing said was already the recovery", async () => {
		expect(
			await planNotification(
				fact({ kind: "instance.reconnected" }),
				async () => "instance.reconnected",
			),
		).toBeUndefined()
	})

	it("asks only about the incident it belongs to, so an older outage cannot answer for it", async () => {
		const lastAnnounced = vi.fn(async () => undefined)
		await planNotification(
			fact({
				kind: "instance.reconnected",
				subjectType: "instance",
				subjectId: "i1",
				incidentId: "inc_7",
			}),
			lastAnnounced,
		)

		expect(lastAnnounced).toHaveBeenCalledWith(
			"instance",
			"i1",
			["instance.disconnected", "instance.reconnected"],
			"inc_7",
		)
	})

	it("holds for every declared recovery, not just the connection one", async () => {
		for (const kind of RESOLVING_EVENT_KINDS) {
			expect(await planNotification(fact({ kind }), never)).toBeUndefined()
			const announced = await planNotification(
				fact({ kind }),
				async (_type, _id, kinds) => kinds[0],
			)
			expect(announced?.kind).toBe(kind)
		}
	})

	it("never asks the database anything for a problem, only for a recovery", async () => {
		const lastAnnounced = vi.fn(async () => undefined)
		await planNotification(fact({ kind: "host.unreachable" }), lastAnnounced)
		expect(lastAnnounced).not.toHaveBeenCalled()
	})
})

describe("what gets written", () => {
	it("carries copy a Minecraft player can act on", async () => {
		const planned = await planNotification(fact(), never)
		expect(planned?.title).toBe("basement-box is not responding")
		expect(planned?.body.length).toBeGreaterThan(0)
	})

	it("names no machinery in any message", async () => {
		const messages: string[] = []
		for (const kind of STATUS_EVENT_KINDS) {
			const planned = await planNotification(fact({ kind }), async (_type, _id, kinds) => kinds[0])
			if (planned) messages.push(planned.title, planned.body)
		}

		expect(messages.length).toBeGreaterThan(20)
		for (const message of messages) {
			expect(message).not.toMatch(
				/systemd|journal|SSH|tunnel|unit|daemon|webhook|payload|HTTP|process|drift|flap/i,
			)
		}
	})

	it("ties the message to the one event that caused it, so a retry cannot duplicate it", async () => {
		const planned = await planNotification(fact({ statusEventId: "evt_9" }), never)
		expect(planned?.dedupeKey).toBe(dedupeKeyFor("evt_9"))
		expect(planned?.sourceStatusEventId).toBe("evt_9")
	})
})

describe("the kinds a recovery looks back at", () => {
	it("is the problem and the recovery, so the most recent of the two decides", () => {
		expect(relevantKinds("host.recovered")).toEqual(["host.unreachable", "host.recovered"])
	})

	it("is just itself for a problem", () => {
		expect(relevantKinds("host.unreachable")).toEqual(["host.unreachable"])
	})
})

describe("the sixth drop, and why it must stay silent", () => {
	it("still reads as flapping, so the predicate alone cannot be the guard", () => {
		const now = new Date("2026-09-07T12:00:00Z")
		const five = [0, 2, 4, 6, 8].map((m) => new Date(now.getTime() - m * 60_000))
		const six = [...five, new Date(now.getTime() - 10 * 60_000)]

		expect(isFlapping(five, now)).toBe(true)
		expect(isFlapping(six, now)).toBe(true)
	})

	it("stops reading as flapping once the drops age out of the window", () => {
		const now = new Date("2026-09-07T13:00:00Z")
		const old = [0, 2, 4, 6, 8].map((m) => new Date(now.getTime() - (40 + m) * 60_000))

		expect(isFlapping(old, now)).toBe(false)
	})

	it("does not read as flapping on four drops", () => {
		const now = new Date("2026-09-07T12:00:00Z")
		const four = [0, 2, 4, 6].map((m) => new Date(now.getTime() - m * 60_000))

		expect(isFlapping(four, now)).toBe(false)
	})
})

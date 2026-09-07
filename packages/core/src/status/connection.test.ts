import type { ConnectionSignal } from "@open-mcc/contracts/boundary/journal"
import { describe, expect, it } from "vitest"
import {
	type ConnectionCurrent,
	changesFromSignals,
	escalateIfStillDown,
	UNOBSERVED_CONNECTION,
} from "./connection"

const at = (minutes: number): Date => new Date(Date.UTC(2026, 8, 6, 14, minutes, 0))

const joined = (minutes: number, pid = "1"): ConnectionSignal => ({
	kind: "joined",
	at: at(minutes),
	pid,
})

const dropped = (minutes: number, reason?: string, pid = "1"): ConnectionSignal => ({
	kind: "disconnected",
	at: at(minutes),
	pid,
	reason,
})

const current = (patch: Partial<ConnectionCurrent>): ConnectionCurrent => ({
	...UNOBSERVED_CONNECTION,
	...patch,
})

describe("deciding when a bot is on its server", () => {
	it("calls the first join a join, not a reconnect", () => {
		const [change] = changesFromSignals(UNOBSERVED_CONNECTION, [joined(0)])

		expect(change).toMatchObject({ state: "joined", event: "instance.joined" })
	})

	it("calls a later join a reconnect", () => {
		const [change] = changesFromSignals(current({ state: "interrupted", since: at(0) }), [
			joined(5),
		])

		expect(change?.event).toBe("instance.reconnected")
	})

	it("tells a kick apart from an ordinary drop, and keeps the reason", () => {
		const [kick] = changesFromSignals(current({ state: "joined" }), [
			dropped(1, "Kicked by an operator"),
		])
		const [drop] = changesFromSignals(current({ state: "joined" }), [dropped(1)])

		expect(kick).toMatchObject({ event: "instance.kicked", reason: "Kicked by an operator" })
		expect(drop?.event).toBe("instance.connection_lost")
	})

	it("treats a ban as a kick", () => {
		const [change] = changesFromSignals(current({ state: "joined" }), [
			dropped(1, "You are banned from this server"),
		])

		expect(change?.event).toBe("instance.kicked")
	})

	it("says nothing when a joined bot is seen joining again", () => {
		expect(changesFromSignals(current({ state: "joined" }), [joined(5)])).toEqual([])
	})

	it("does not report a second drop while already interrupted", () => {
		const changes = changesFromSignals(current({ state: "joined" }), [dropped(1), dropped(2)])

		expect(changes).toHaveLength(1)
	})

	it("follows a whole drop and rejoin in order", () => {
		const changes = changesFromSignals(current({ state: "joined" }), [
			dropped(1, "Kicked by an operator"),
			joined(2, "2"),
		])

		expect(changes.map((change) => change.event)).toEqual([
			"instance.kicked",
			"instance.reconnected",
		])
	})
})

describe("a bot whose client was stopped", () => {
	it("is off its server, and says so as a stop rather than a lost connection", () => {
		const [change] = changesFromSignals(current({ state: "joined" }), [
			{ kind: "stopped", at: at(5), pid: "1" },
		])

		expect(change).toMatchObject({ state: "down", event: "instance.stopped" })
	})

	it("is not reported twice while it stays stopped", () => {
		const changes = changesFromSignals(current({ state: "joined" }), [
			{ kind: "stopped", at: at(5), pid: "1" },
			{ kind: "stopped", at: at(6), pid: "1" },
		])

		expect(changes).toHaveLength(1)
	})

	it("counts as on its server again once it rejoins", () => {
		const changes = changesFromSignals(current({ state: "joined" }), [
			{ kind: "stopped", at: at(5), pid: "1" },
			{ kind: "joined", at: at(9), pid: "2" },
		])

		expect(changes.map((change) => change.event)).toEqual([
			"instance.stopped",
			"instance.reconnected",
		])
	})
})

describe("escalating a bot that has not come back", () => {
	it("waits before calling a brief interruption a disconnection", () => {
		expect(
			escalateIfStillDown(current({ state: "interrupted", since: at(0) }), at(1)),
		).toBeUndefined()
	})

	it("raises it once the interruption has lasted long enough", () => {
		const change = escalateIfStillDown(current({ state: "interrupted", since: at(0) }), at(2))

		expect(change).toMatchObject({ state: "down", event: "instance.disconnected" })
	})

	it("says nothing about a bot that is on its server", () => {
		expect(escalateIfStillDown(current({ state: "joined", since: at(0) }), at(30))).toBeUndefined()
	})

	it("does not raise it twice", () => {
		expect(escalateIfStillDown(current({ state: "down", since: at(0) }), at(30))).toBeUndefined()
	})
})

describe("the quiet cases, which decide whether an operator keeps alerts on", () => {
	const interrupted = (since: Date) => ({
		state: "interrupted" as const,
		since,
		pid: "1",
	})

	it("says nothing while a bot is still inside its grace period", () => {
		const at = new Date("2026-09-07T12:00:00Z")
		const oneMinuteLater = new Date("2026-09-07T12:01:00Z")

		expect(escalateIfStillDown(interrupted(at), oneMinuteLater)).toBeUndefined()
	})

	it("escalates once the grace period has passed", () => {
		const at = new Date("2026-09-07T12:00:00Z")
		const threeMinutesLater = new Date("2026-09-07T12:03:00Z")

		expect(escalateIfStillDown(interrupted(at), threeMinutesLater)?.event).toBe(
			"instance.disconnected",
		)
	})

	it("says nothing about a bot that is already back on", () => {
		const at = new Date("2026-09-07T12:00:00Z")
		const later = new Date("2026-09-07T12:30:00Z")

		expect(escalateIfStillDown({ state: "joined", since: null, pid: "1" }, later)).toBeUndefined()
		expect(escalateIfStillDown({ state: "down", since: at, pid: "1" }, later)).toBeUndefined()
	})

	it("says nothing when it never knew when the loss started", () => {
		expect(
			escalateIfStillDown(
				{ state: "interrupted", since: null, pid: "1" },
				new Date("2026-09-07T13:00:00Z"),
			),
		).toBeUndefined()
	})
})

import type { InstanceSignalRow, InstanceTaskRow, InstanceTaskTimeRow } from "@open-mcc/db"
import { describe, expect, it } from "vitest"
import { UnknownTimezoneError } from "./due"
import {
	evenJitter,
	intervalArmOf,
	intervalClaimOf,
	intervalPlan,
	orderedSteps,
	signalClaims,
	timeClaims,
	wantsJoinSignal,
	wantsRespawnSignal,
} from "./task"

const CREATED = new Date("2024-03-01T00:00:00.000Z")

const taskRow = (overrides: Partial<InstanceTaskRow> = {}): InstanceTaskRow => ({
	id: "task-1",
	organizationId: "org-1",
	instanceId: "inst-1",
	name: "Switch to eco",
	stepDelaySeconds: 3,
	enabled: true,
	timezone: "UTC",
	onFirstLogin: false,
	onLogin: false,
	onRespawn: false,
	intervalMinSeconds: null,
	intervalMaxSeconds: null,
	intervalNextRunAt: null,
	intervalObservedAt: null,
	lastRunAt: null,
	lastRunError: null,
	createdAt: CREATED,
	...overrides,
})

const signalRow = (overrides: Partial<InstanceSignalRow> = {}): InstanceSignalRow => ({
	id: "sig-1",
	organizationId: "org-1",
	instanceId: "inst-1",
	kind: "login",
	identity: "4242:2024-03-02T10:00:00.000Z",
	process: "4242",
	firstForProcess: false,
	occurredAt: new Date("2024-03-02T10:00:00.000Z"),
	observedAt: new Date("2024-03-02T10:00:20.000Z"),
	...overrides,
})

const timeRow = (overrides: Partial<InstanceTaskTimeRow> = {}): InstanceTaskTimeRow => ({
	id: "time-1",
	organizationId: "org-1",
	taskId: "task-1",
	daysOfWeek: "*",
	minuteOfDay: 9 * 60,
	...overrides,
})

describe("which signals a task needs", () => {
	it("asks for joins only when a login trigger is on", () => {
		expect(wantsJoinSignal(taskRow())).toBe(false)
		expect(wantsJoinSignal(taskRow({ onLogin: true }))).toBe(true)
		expect(wantsJoinSignal(taskRow({ onFirstLogin: true }))).toBe(true)
		expect(wantsJoinSignal(taskRow({ onRespawn: true }))).toBe(false)
	})

	it("asks for respawns only when the respawn trigger is on", () => {
		expect(wantsRespawnSignal(taskRow())).toBe(false)
		expect(wantsRespawnSignal(taskRow({ onRespawn: true }))).toBe(true)
	})
})

describe("claims a join raises", () => {
	it("keys a login claim on the join identity, so the same join never fires twice", () => {
		const claims = signalClaims(taskRow({ onLogin: true }), [signalRow()])
		expect(claims).toEqual([{ trigger: "login", claimKey: "login:4242:2024-03-02T10:00:00.000Z" }])
	})

	it("raises first login only for the first join of a process, and login alongside it", () => {
		const both = taskRow({ onLogin: true, onFirstLogin: true })
		const first = signalClaims(both, [signalRow({ firstForProcess: true })])
		expect(first.map((claim) => claim.trigger)).toEqual(["firstLogin", "login"])

		const later = signalClaims(both, [signalRow({ firstForProcess: false })])
		expect(later.map((claim) => claim.trigger)).toEqual(["login"])
	})

	it("takes the newest join when the window holds several, so a relog burst fires once", () => {
		const claims = signalClaims(taskRow({ onLogin: true }), [
			signalRow({ id: "a", identity: "1:2024-03-02T10:00:00.000Z" }),
			signalRow({
				id: "b",
				identity: "1:2024-03-02T10:05:00.000Z",
				occurredAt: new Date("2024-03-02T10:05:00.000Z"),
			}),
		])
		expect(claims).toEqual([{ trigger: "login", claimKey: "login:1:2024-03-02T10:05:00.000Z" }])
	})

	it("ignores a join older than the task itself", () => {
		const claims = signalClaims(taskRow({ onLogin: true }), [
			signalRow({ occurredAt: new Date("2024-02-01T00:00:00.000Z") }),
		])
		expect(claims).toEqual([])
	})

	it("raises a respawn claim keyed on the client's own event id", () => {
		const claims = signalClaims(taskRow({ onRespawn: true }), [
			signalRow({ kind: "respawn", identity: "918", process: null }),
		])
		expect(claims).toEqual([{ trigger: "respawn", claimKey: "respawn:918" }])
	})

	it("raises nothing for a trigger that is off", () => {
		expect(signalClaims(taskRow(), [signalRow(), signalRow({ kind: "respawn" })])).toEqual([])
	})
})

describe("claims a time of day raises", () => {
	const definitionAt = (times: InstanceTaskTimeRow[], timezone = "UTC") => ({
		row: taskRow({ timezone }),
		steps: [],
		times,
	})

	it("keys a time claim on the local day and the minute, so it fires once a day", () => {
		const claims = timeClaims(definitionAt([timeRow()]), new Date("2024-03-02T09:00:00.000Z"))
		expect(claims).toEqual([{ trigger: "time", claimKey: "time:2024-03-02:540" }])
	})

	it("still claims the same key inside the catch-up window", () => {
		const late = timeClaims(definitionAt([timeRow()]), new Date("2024-03-02T09:45:00.000Z"))
		expect(late).toEqual([{ trigger: "time", claimKey: "time:2024-03-02:540" }])
	})

	it("stops claiming once the catch-up window has passed", () => {
		expect(timeClaims(definitionAt([timeRow()]), new Date("2024-03-02T10:05:00.000Z"))).toEqual([])
	})

	it("reads the day and the date key in the task's own zone", () => {
		const claims = timeClaims(
			definitionAt([timeRow({ daysOfWeek: "Sat", minuteOfDay: 8 * 60 })], "Pacific/Auckland"),
			new Date("2024-03-01T19:00:00.000Z"),
		)
		expect(claims).toEqual([{ trigger: "time", claimKey: "time:2024-03-02:480" }])
	})

	it("claims each matching time separately", () => {
		const claims = timeClaims(
			definitionAt([timeRow(), timeRow({ id: "t2", minuteOfDay: 9 * 60 + 30 })]),
			new Date("2024-03-02T09:30:00.000Z"),
		)
		expect(claims.map((claim) => claim.claimKey)).toEqual([
			"time:2024-03-02:540",
			"time:2024-03-02:570",
		])
	})

	it("refuses a zone it cannot read rather than firing on the wrong clock", () => {
		expect(() =>
			timeClaims(definitionAt([timeRow()], "Nowhere/Land"), new Date("2024-03-02T09:00:00.000Z")),
		).toThrow(UnknownTimezoneError)
	})
})

describe("the interval countdown", () => {
	const exact = { intervalMinSeconds: 3600, intervalMaxSeconds: 3600 }
	const fixed = (minSeconds: number) => () => minSeconds

	it("says nothing when no interval is configured", () => {
		expect(intervalPlan(taskRow(), CREATED, true, evenJitter)).toEqual({ kind: "unarmed" })
	})

	it("arms from now the first time it is seen", () => {
		const at = new Date("2024-03-02T10:00:00.000Z")
		const plan = intervalPlan(taskRow(exact), at, true, fixed(3600))
		expect(plan.kind).toBe("arm")
		expect(intervalArmOf(plan)).toEqual({
			nextRunAt: new Date("2024-03-02T11:00:00.000Z"),
			observedAt: at,
		})
		expect(intervalClaimOf(plan)).toBeUndefined()
	})

	it("counts down while the bot runs", () => {
		const plan = intervalPlan(
			taskRow({
				...exact,
				intervalNextRunAt: new Date("2024-03-02T11:00:00.000Z"),
				intervalObservedAt: new Date("2024-03-02T10:00:00.000Z"),
			}),
			new Date("2024-03-02T10:30:00.000Z"),
			true,
			fixed(3600),
		)
		expect(plan.kind).toBe("wait")
		expect(intervalArmOf(plan)?.nextRunAt).toEqual(new Date("2024-03-02T11:00:00.000Z"))
	})

	it("pauses while the bot is not running, so a stopped bot wakes to no backlog", () => {
		const plan = intervalPlan(
			taskRow({
				...exact,
				intervalNextRunAt: new Date("2024-03-02T11:00:00.000Z"),
				intervalObservedAt: new Date("2024-03-02T10:00:00.000Z"),
			}),
			new Date("2024-03-02T18:00:00.000Z"),
			false,
			fixed(3600),
		)
		expect(plan.kind).toBe("hold")
		expect(intervalArmOf(plan)).toEqual({
			nextRunAt: new Date("2024-03-02T19:00:00.000Z"),
			observedAt: new Date("2024-03-02T18:00:00.000Z"),
		})
		expect(intervalClaimOf(plan)).toBeUndefined()
	})

	it("fires once on the armed moment and re-arms from now", () => {
		const armed = new Date("2024-03-02T11:00:00.000Z")
		const at = new Date("2024-03-02T11:00:20.000Z")
		const plan = intervalPlan(
			taskRow({ ...exact, intervalNextRunAt: armed, intervalObservedAt: armed }),
			at,
			true,
			fixed(3600),
		)
		expect(intervalClaimOf(plan)).toEqual({
			trigger: "interval",
			claimKey: "interval:2024-03-02T11:00:00.000Z",
		})
		expect(intervalArmOf(plan)).toEqual({
			nextRunAt: new Date("2024-03-02T12:00:20.000Z"),
			observedAt: at,
		})
	})

	it("keys the claim on the armed moment, so a restarted worker cannot fire it twice", () => {
		const armed = new Date("2024-03-02T11:00:00.000Z")
		const row = taskRow({ ...exact, intervalNextRunAt: armed, intervalObservedAt: armed })
		const first = intervalClaimOf(
			intervalPlan(row, new Date("2024-03-02T11:00:20.000Z"), true, fixed(3600)),
		)
		const again = intervalClaimOf(
			intervalPlan(row, new Date("2024-03-02T11:00:50.000Z"), true, fixed(3600)),
		)
		expect(first).toEqual(again)
	})

	it("takes the exact wait when the two bounds agree and stays inside them when they differ", () => {
		expect(evenJitter(60, 60)).toBe(60)
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const picked = evenJitter(10, 20)
			expect(picked).toBeGreaterThanOrEqual(10)
			expect(picked).toBeLessThanOrEqual(20)
		}
	})
})

describe("step order", () => {
	it("sorts by position rather than by the order the rows came back", () => {
		const steps = orderedSteps({
			row: taskRow(),
			times: [],
			steps: [
				{ id: "c", organizationId: "org-1", taskId: "task-1", position: 2, command: "/visit me" },
				{ id: "a", organizationId: "org-1", taskId: "task-1", position: 0, command: "/economy" },
				{ id: "b", organizationId: "org-1", taskId: "task-1", position: 1, command: "/local" },
			],
		})
		expect(steps.map((step) => step.command)).toEqual(["/economy", "/local", "/visit me"])
	})
})

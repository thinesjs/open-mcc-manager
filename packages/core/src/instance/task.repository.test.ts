import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedOrganization, teardownTestDb, testDb, trackHostId, trackInstanceId } from "../test/db"
import { TASK_ABANDONED_REASON } from "./task"
import { createTaskRepository, type TaskValues } from "./task.repository"

const repo = createTaskRepository(testDb())
let org = ""
let instanceId = ""
let scope = { organizationId: "" }

const values = (overrides: Partial<TaskValues> = {}): TaskValues => ({
	instanceId,
	name: `task-${Math.random().toString(36).slice(2, 10)}`,
	stepDelaySeconds: 3,
	enabled: true,
	timezone: "UTC",
	onFirstLogin: false,
	onLogin: true,
	onRespawn: false,
	intervalMinSeconds: null,
	intervalMaxSeconds: null,
	...overrides,
})

const longAgo = new Date("2000-01-01T00:00:00.000Z")

beforeAll(async () => {
	org = await seedOrganization("task")
	scope = { organizationId: org }
	const hostId = `host-${Math.random().toString(36).slice(2, 10)}`
	await testDb()
		.insertInto("host")
		.values({ id: hostId, organizationId: org, name: hostId, hostname: "10.0.0.1" })
		.execute()
	trackHostId(hostId)
	const row = await testDb()
		.insertInto("instance")
		.values({
			id: `inst-${Math.random().toString(36).slice(2, 10)}`,
			organizationId: org,
			hostId,
			name: "afk",
			minecraftAccount: "a@b.com",
			minecraftUsername: null,
			liveControlPort: 34733,
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	trackInstanceId(row.id)
	instanceId = row.id
})

afterAll(async () => {
	await teardownTestDb()
})

describe("claiming a task run", () => {
	it("lets exactly one of two concurrent claims win, so two workers cannot both send", async () => {
		const task = await repo.insert(scope, values())
		const at = new Date()

		const [first, second] = await Promise.all([
			repo.claimRun(scope, task.id, "login", "login:4242:once", at),
			repo.claimRun(scope, task.id, "login", "login:4242:once", at),
		])

		expect([first, second].filter((id) => id !== undefined)).toHaveLength(1)
	})

	it("refuses a second claim on the same key however much later it comes", async () => {
		const task = await repo.insert(scope, values())
		expect(
			await repo.claimRun(scope, task.id, "time", "time:2024-03-02:540", new Date()),
		).toBeTypeOf("string")
		expect(
			await repo.claimRun(scope, task.id, "time", "time:2024-03-02:540", new Date()),
		).toBeUndefined()
	})

	it("takes a claim on a different key, so the next day and the next join still fire", async () => {
		const task = await repo.insert(scope, values())
		expect(
			await repo.claimRun(scope, task.id, "time", "time:2024-03-02:540", new Date()),
		).toBeTypeOf("string")
		expect(
			await repo.claimRun(scope, task.id, "time", "time:2024-03-03:540", new Date()),
		).toBeTypeOf("string")
	})

	it("keeps two tasks' claims apart even when their keys match", async () => {
		const left = await repo.insert(scope, values())
		const right = await repo.insert(scope, values())
		expect(await repo.claimRun(scope, left.id, "login", "login:same", new Date())).toBeTypeOf(
			"string",
		)
		expect(await repo.claimRun(scope, right.id, "login", "login:same", new Date())).toBeTypeOf(
			"string",
		)
	})
})

describe("recording what a run did", () => {
	it("keeps the outcome, the steps sent and the failure on the run", async () => {
		const task = await repo.insert(scope, values())
		const runId = await repo.claimRun(scope, task.id, "login", "login:recorded", new Date())
		if (runId === undefined) throw new Error("expected the claim to be taken")
		await repo.finishRun(scope, runId, "failed", 1, "Step 2 of 3 failed", new Date())

		const listed = await repo.listForInstance(scope, instanceId, longAgo)
		const run = listed.flatMap((parts) => parts.runs).find((each) => each.id === runId)
		expect(run?.outcome).toBe("failed")
		expect(run?.stepsSent).toBe(1)
		expect(run?.error).toBe("Step 2 of 3 failed")
	})

	it("closes a run the manager never finished rather than leaving it running for ever", async () => {
		const task = await repo.insert(scope, values())
		const runId = await repo.claimRun(scope, task.id, "login", "login:abandoned", longAgo)
		if (runId === undefined) throw new Error("expected the claim to be taken")

		await repo.abandonStaleRuns(new Date(), TASK_ABANDONED_REASON)

		const listed = await repo.listForInstance(scope, instanceId, longAgo)
		const run = listed.flatMap((parts) => parts.runs).find((each) => each.id === runId)
		expect(run?.outcome).toBe("abandoned")
		expect(run?.error).toBe(TASK_ABANDONED_REASON)
	})

	it("never sweeps a run that is still going", async () => {
		const task = await repo.insert(scope, values())
		const runId = await repo.claimRun(scope, task.id, "login", "login:inflight", new Date())
		if (runId === undefined) throw new Error("expected the claim to be taken")

		await repo.abandonStaleRuns(new Date(Date.now() - 60_000), TASK_ABANDONED_REASON)

		const listed = await repo.listForInstance(scope, instanceId, longAgo)
		const run = listed.flatMap((parts) => parts.runs).find((each) => each.id === runId)
		expect(run?.outcome).toBe("running")
	})

	it("prunes finished runs past the retention window and leaves running ones alone", async () => {
		const task = await repo.insert(scope, values())
		const stale = await repo.claimRun(scope, task.id, "login", "login:pruned", longAgo)
		const live = await repo.claimRun(scope, task.id, "login", "login:kept", longAgo)
		if (stale === undefined || live === undefined) throw new Error("expected both claims")
		await repo.finishRun(scope, stale, "sent", 2, null, longAgo)

		await repo.pruneRuns(new Date())

		const listed = await repo.listForInstance(scope, instanceId, longAgo)
		const ids = listed.flatMap((parts) => parts.runs).map((each) => each.id)
		expect(ids).not.toContain(stale)
		expect(ids).toContain(live)
	})
})

describe("recording a signal", () => {
	it("records a join once, however many reads see the same line", async () => {
		const identity = `1:${new Date().toISOString()}`
		const first = await repo.recordSignal(scope, {
			instanceId,
			kind: "login",
			identity,
			process: "1",
			firstForProcess: true,
			occurredAt: new Date(),
			observedAt: new Date(),
		})
		const again = await repo.recordSignal(scope, {
			instanceId,
			kind: "login",
			identity,
			process: "1",
			firstForProcess: true,
			occurredAt: new Date(),
			observedAt: new Date(),
		})
		expect(first).toBe(true)
		expect(again).toBe(false)
	})

	it("knows whether this bot has joined under a process before", async () => {
		expect(await repo.hasJoinedAs(scope, instanceId, "5150")).toBe(false)
		await repo.recordSignal(scope, {
			instanceId,
			kind: "login",
			identity: `5150:${new Date().toISOString()}`,
			process: "5150",
			firstForProcess: true,
			occurredAt: new Date(),
			observedAt: new Date(),
		})
		expect(await repo.hasJoinedAs(scope, instanceId, "5150")).toBe(true)
	})

	it("keeps a login and a respawn apart even when their identities collide", async () => {
		const at = new Date()
		expect(
			await repo.recordSignal(scope, {
				instanceId,
				kind: "respawn",
				identity: "77",
				process: null,
				firstForProcess: false,
				occurredAt: at,
				observedAt: at,
			}),
		).toBe(true)
		expect(
			await repo.recordSignal(scope, {
				instanceId,
				kind: "login",
				identity: "77",
				process: "77",
				firstForProcess: false,
				occurredAt: at,
				observedAt: at,
			}),
		).toBe(true)
	})

	it("hands back only the signals inside the window it was asked for", async () => {
		const at = new Date()
		await repo.recordSignal(scope, {
			instanceId,
			kind: "respawn",
			identity: `old-${Math.random()}`,
			process: null,
			firstForProcess: false,
			occurredAt: longAgo,
			observedAt: at,
		})
		const recent = `new-${Math.random()}`
		await repo.recordSignal(scope, {
			instanceId,
			kind: "respawn",
			identity: recent,
			process: null,
			firstForProcess: false,
			occurredAt: at,
			observedAt: at,
		})

		const seen = await repo.signalsSince(scope, instanceId, new Date(at.getTime() - 60_000))
		expect(seen.map((signal) => signal.identity)).toContain(recent)
		expect(seen.every((signal) => signal.occurredAt.getTime() >= at.getTime() - 60_000)).toBe(true)
	})
})

describe("a task's cursor", () => {
	it("starts absent, keeps what it was given and replaces it on the next write", async () => {
		expect(await repo.readSignalCursor(scope, instanceId, "liveEvents")).toBeNull()
		await repo.writeSignalCursor(scope, instanceId, "liveEvents", "12", new Date())
		expect(await repo.readSignalCursor(scope, instanceId, "liveEvents")).toBe("12")
		await repo.writeSignalCursor(scope, instanceId, "liveEvents", "44", new Date())
		expect(await repo.readSignalCursor(scope, instanceId, "liveEvents")).toBe("44")
	})

	it("keeps the journal cursor and the event cursor apart", async () => {
		await repo.writeSignalCursor(scope, instanceId, "journal", "s=abc", new Date())
		expect(await repo.readSignalCursor(scope, instanceId, "journal")).toBe("s=abc")
		expect(await repo.readSignalCursor(scope, instanceId, "liveEvents")).not.toBe("s=abc")
	})
})

describe("storing a task's steps and times", () => {
	it("keeps the steps in the order they were given", async () => {
		const task = await repo.insert(scope, values())
		await repo.replaceSteps(scope, task.id, ["/economy", "/local", "/visit .ArrayIndexInOfB"])
		const steps = await repo.stepsFor(scope, task.id)
		expect(steps.map((step) => step.command)).toEqual([
			"/economy",
			"/local",
			"/visit .ArrayIndexInOfB",
		])
		expect(steps.map((step) => step.position)).toEqual([0, 1, 2])
	})

	it("replaces the whole list rather than appending to it", async () => {
		const task = await repo.insert(scope, values())
		await repo.replaceSteps(scope, task.id, ["/economy", "/local"])
		await repo.replaceSteps(scope, task.id, ["/hub"])
		expect((await repo.stepsFor(scope, task.id)).map((step) => step.command)).toEqual(["/hub"])
	})

	it("clears the armed interval when the task is edited, so an old arming cannot fire", async () => {
		const task = await repo.insert(
			scope,
			values({ intervalMinSeconds: 60, intervalMaxSeconds: 60 }),
		)
		await repo.armInterval(scope, task.id, {
			nextRunAt: new Date("2030-01-01T00:00:00.000Z"),
			observedAt: new Date(),
		})
		const edited = await repo.update(
			scope,
			task.id,
			values({ name: task.name, intervalMinSeconds: 120, intervalMaxSeconds: 240 }),
		)
		expect(edited?.intervalNextRunAt).toBeNull()
		expect(edited?.intervalObservedAt).toBeNull()
	})

	it("takes only the enabled tasks when the scheduler asks across organizations", async () => {
		const on = await repo.insert(scope, values({ enabled: true }))
		const off = await repo.insert(scope, values({ enabled: false }))
		const listed = await repo.listEnabledAcrossOrganizations(longAgo)
		const ids = listed.map((parts) => parts.task.id)
		expect(ids).toContain(on.id)
		expect(ids).not.toContain(off.id)
	})

	it("takes the whole task away with its steps when it is deleted", async () => {
		const task = await repo.insert(scope, values())
		await repo.replaceSteps(scope, task.id, ["/economy"])
		expect(await repo.deleteReturning(scope, task.id)).toBeDefined()
		expect(await repo.stepsFor(scope, task.id)).toEqual([])
		expect(await repo.findById(scope, task.id)).toBeUndefined()
	})
})

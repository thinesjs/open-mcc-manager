import type { InstanceSignalRow, InstanceTaskRow, InstanceTaskStepRow } from "@open-mcc/db"
import { describe, expect, it } from "vitest"
import type { TaskParts } from "./task.repository"
import { InstanceTaskStepsFailedError } from "./task-run"
import {
	runTaskSchedulerTick,
	startTaskScheduler,
	type TaskSchedulerDeps,
	type TaskSignalNeeds,
} from "./task-scheduler"

const CREATED = new Date("2024-03-01T00:00:00.000Z")
const NOW = new Date("2024-03-02T10:00:20.000Z")

const taskRow = (overrides: Partial<InstanceTaskRow> = {}): InstanceTaskRow => ({
	id: "task-1",
	organizationId: "org-1",
	instanceId: "inst-1",
	name: "Switch to eco",
	stepDelaySeconds: 3,
	enabled: true,
	timezone: "UTC",
	onFirstLogin: false,
	onLogin: true,
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

const step = (position: number, command: string): InstanceTaskStepRow => ({
	id: `step-${position}`,
	organizationId: "org-1",
	taskId: "task-1",
	position,
	command,
})

const partsOf = (overrides: Partial<InstanceTaskRow> = {}): TaskParts => ({
	task: taskRow(overrides),
	steps: [step(0, "/economy"), step(1, "/local")],
	times: [],
	runs: [],
})

const joinSignal = (overrides: Partial<InstanceSignalRow> = {}): InstanceSignalRow => ({
	id: "sig-1",
	organizationId: "org-1",
	instanceId: "inst-1",
	kind: "login",
	identity: "4242:2024-03-02T10:00:00.000Z",
	process: "4242",
	firstForProcess: true,
	occurredAt: new Date("2024-03-02T10:00:00.000Z"),
	observedAt: new Date("2024-03-02T10:00:10.000Z"),
	...overrides,
})

type Harness = {
	deps: TaskSchedulerDeps
	claimed: string[]
	observed: Array<{ instanceId: string; needs: TaskSignalNeeds }>
	armed: Array<{ taskId: string; nextRunAt: Date; observedAt: Date }>
	finished: Array<{ outcome: string; stepsSent: number; error: string | null }>
	recorded: Array<{ taskId: string; error: string | null }>
}

const harness = (
	tasks: TaskParts[],
	overrides: Partial<TaskSchedulerDeps> = {},
	signals: InstanceSignalRow[] = [],
): Harness => {
	const claimed: string[] = []
	const observed: Array<{ instanceId: string; needs: TaskSignalNeeds }> = []
	const armed: Array<{ taskId: string; nextRunAt: Date; observedAt: Date }> = []
	const finished: Array<{ outcome: string; stepsSent: number; error: string | null }> = []
	const recorded: Array<{ taskId: string; error: string | null }> = []

	const deps: TaskSchedulerDeps = {
		enabledTasks: async () => tasks,
		isRunning: async () => true,
		observeSignals: async (_scope, instanceId, needs) => {
			observed.push({ instanceId, needs })
		},
		signalsSince: async () => signals,
		armInterval: async (_scope, taskId, arm) => {
			armed.push({ taskId, ...arm })
		},
		claimRun: async (_scope, taskId, claim) => {
			if (claimed.includes(`${taskId}|${claim.claimKey}`)) return undefined
			claimed.push(`${taskId}|${claim.claimKey}`)
			return `run-${claimed.length}`
		},
		send: async (parts) => parts.steps.length,
		finishRun: async (_scope, _runId, outcome, stepsSent, error) => {
			finished.push({ outcome, stepsSent, error })
		},
		recordTaskOutcome: async (_scope, taskId, _ranAt, error) => {
			recorded.push({ taskId, error })
		},
		sweep: async () => undefined,
		now: () => NOW,
		jitter: (minSeconds) => minSeconds,
		describeFailure: (error) => (error instanceof Error ? error.message : error),
		...overrides,
	}

	return { deps, claimed, observed, armed, finished, recorded }
}

describe("a task scheduler tick", () => {
	it("sweeps abandoned and expired runs before it considers anything", async () => {
		const order: string[] = []
		const made = harness([partsOf()], {
			sweep: async (abandonBefore, pruneBefore, reason) => {
				order.push("sweep")
				expect(abandonBefore.getTime()).toBeLessThan(NOW.getTime())
				expect(pruneBefore.getTime()).toBeLessThan(abandonBefore.getTime())
				expect(reason).toContain("manager stopped")
			},
			enabledTasks: async () => {
				order.push("list")
				return [partsOf()]
			},
		})
		await runTaskSchedulerTick(made.deps)
		expect(order).toEqual(["sweep", "list"])
	})

	it("keeps considering tasks when the sweep itself fails", async () => {
		const reported: string[] = []
		const made = harness([partsOf()], {
			sweep: async () => {
				throw new Error("the sweep could not run")
			},
			onError: (message) => reported.push(message),
		})
		const run = await runTaskSchedulerTick(made.deps)
		expect(reported).toContain("Task runs could not be swept")
		expect(run.considered).toBe(1)
	})

	it("reads signals once per bot rather than once per task", async () => {
		const made = harness([
			partsOf(),
			{ ...partsOf({ id: "task-2", name: "Second" }), steps: [step(0, "/hello")] },
		])
		await runTaskSchedulerTick(made.deps)
		expect(made.observed).toEqual([{ instanceId: "inst-1", needs: { join: true, respawn: false } }])
	})

	it("reads no signals at all for a bot whose tasks need none", async () => {
		const made = harness([partsOf({ onLogin: false, onFirstLogin: false })])
		await runTaskSchedulerTick(made.deps)
		expect(made.observed).toEqual([])
	})

	it("asks for respawns only when a task wants them", async () => {
		const made = harness([partsOf({ onLogin: false, onRespawn: true })])
		await runTaskSchedulerTick(made.deps)
		expect(made.observed).toEqual([{ instanceId: "inst-1", needs: { join: false, respawn: true } }])
	})

	it("reads no signals from a bot that is not running", async () => {
		const made = harness([partsOf()], { isRunning: async () => false })
		await runTaskSchedulerTick(made.deps)
		expect(made.observed).toEqual([])
	})

	it("claims a run before sending anything", async () => {
		const order: string[] = []
		const made = harness(
			[partsOf()],
			{
				claimRun: async () => {
					order.push("claim")
					return "run-1"
				},
				send: async () => {
					order.push("send")
					return 2
				},
			},
			[joinSignal()],
		)
		await runTaskSchedulerTick(made.deps)
		expect(order).toEqual(["claim", "send"])
	})

	it("sends nothing when the claim was already taken", async () => {
		const sends: number[] = []
		const made = harness(
			[partsOf()],
			{
				claimRun: async () => undefined,
				send: async () => {
					sends.push(1)
					return 2
				},
			},
			[joinSignal()],
		)
		const run = await runTaskSchedulerTick(made.deps)
		expect(sends).toEqual([])
		expect(run.unclaimed).toBe(1)
		expect(run.fired).toEqual([])
	})

	it("fires a join once however many ticks see it", async () => {
		const made = harness([partsOf()], {}, [joinSignal()])
		const first = await runTaskSchedulerTick(made.deps)
		const second = await runTaskSchedulerTick(made.deps)
		expect(first.fired).toEqual(["task-1"])
		expect(second.fired).toEqual([])
		expect(second.unclaimed).toBe(1)
	})

	it("fires first login and login as two separately claimed runs", async () => {
		const made = harness([partsOf({ onFirstLogin: true })], {}, [joinSignal()])
		const run = await runTaskSchedulerTick(made.deps)
		expect(made.claimed).toEqual([
			"task-1|firstLogin:4242:2024-03-02T10:00:00.000Z",
			"task-1|login:4242:2024-03-02T10:00:00.000Z",
		])
		expect(run.fired).toEqual(["task-1", "task-1"])
	})

	it("sends nothing while the bot is down, even when a time is due", async () => {
		const parts = partsOf({ onLogin: false })
		const due: TaskParts = {
			...parts,
			times: [
				{
					id: "time-1",
					organizationId: "org-1",
					taskId: "task-1",
					daysOfWeek: "*",
					minuteOfDay: 10 * 60,
				},
			],
		}
		const made = harness([due], { isRunning: async () => false })
		const run = await runTaskSchedulerTick(made.deps)
		expect(run.fired).toEqual([])
		expect(made.claimed).toEqual([])
	})

	it("holds the interval forward while the bot is down and never fires it", async () => {
		const made = harness(
			[
				partsOf({
					onLogin: false,
					intervalMinSeconds: 3600,
					intervalMaxSeconds: 3600,
					intervalNextRunAt: new Date("2024-03-02T09:00:00.000Z"),
					intervalObservedAt: new Date("2024-03-02T08:00:00.000Z"),
				}),
			],
			{ isRunning: async () => false },
		)
		const run = await runTaskSchedulerTick(made.deps)
		expect(run.fired).toEqual([])
		expect(made.armed).toEqual([
			{
				taskId: "task-1",
				nextRunAt: new Date("2024-03-02T11:00:20.000Z"),
				observedAt: NOW,
			},
		])
	})

	it("re-arms the interval as it fires, so the next armed moment is a new claim", async () => {
		const made = harness([
			partsOf({
				onLogin: false,
				intervalMinSeconds: 3600,
				intervalMaxSeconds: 3600,
				intervalNextRunAt: new Date("2024-03-02T10:00:00.000Z"),
				intervalObservedAt: new Date("2024-03-02T09:00:00.000Z"),
			}),
		])
		const run = await runTaskSchedulerTick(made.deps)
		expect(made.claimed).toEqual(["task-1|interval:2024-03-02T10:00:00.000Z"])
		expect(made.armed[0]?.nextRunAt).toEqual(new Date("2024-03-02T11:00:20.000Z"))
		expect(run.fired).toEqual(["task-1"])
	})

	it("records how far a half-finished run got and never retries it", async () => {
		const made = harness(
			[partsOf()],
			{
				send: async () => {
					throw new InstanceTaskStepsFailedError("Step 2 of 2 failed and the rest were not sent", 1)
				},
			},
			[joinSignal()],
		)
		const first = await runTaskSchedulerTick(made.deps)
		expect(first.failed).toEqual([
			{ taskId: "task-1", reason: "Step 2 of 2 failed and the rest were not sent" },
		])
		expect(made.finished).toEqual([
			{
				outcome: "failed",
				stepsSent: 1,
				error: "Step 2 of 2 failed and the rest were not sent",
			},
		])

		const second = await runTaskSchedulerTick(made.deps)
		expect(second.fired).toEqual([])
		expect(second.unclaimed).toBe(1)
	})

	it("puts a failure on the task the way a scheduled command does", async () => {
		const made = harness(
			[partsOf()],
			{
				send: async () => {
					throw new Error("The bot was not running")
				},
			},
			[joinSignal()],
		)
		await runTaskSchedulerTick(made.deps)
		expect(made.recorded).toEqual([{ taskId: "task-1", error: "The bot was not running" }])
	})

	it("clears the last failure when a run succeeds", async () => {
		const made = harness([partsOf({ lastRunError: "older failure" })], {}, [joinSignal()])
		await runTaskSchedulerTick(made.deps)
		expect(made.recorded).toEqual([{ taskId: "task-1", error: null }])
		expect(made.finished).toEqual([{ outcome: "sent", stepsSent: 2, error: null }])
	})

	it("keeps going for the other bots when one of them cannot be read", async () => {
		const other: TaskParts = {
			...partsOf({ id: "task-2", instanceId: "inst-2", name: "Second" }),
			steps: [step(0, "/hello")],
		}
		const made = harness([partsOf(), other], {
			isRunning: async (_scope, instanceId) => {
				if (instanceId === "inst-1") throw new Error("the row could not be read")
				return true
			},
			signalsSince: async () => [
				joinSignal({ instanceId: "inst-2", identity: "9:2024-03-02T10:00:00.000Z" }),
			],
		})
		const run = await runTaskSchedulerTick(made.deps)
		expect(run.fired).toEqual(["task-2"])
	})

	it("records the failure and skips the task when its zone cannot be read", async () => {
		const parts = partsOf({ onLogin: false, timezone: "Nowhere/Land" })
		const due: TaskParts = {
			...parts,
			times: [
				{
					id: "time-1",
					organizationId: "org-1",
					taskId: "task-1",
					daysOfWeek: "*",
					minuteOfDay: 10 * 60,
				},
			],
		}
		const made = harness([due])
		const run = await runTaskSchedulerTick(made.deps)
		expect(run.failed).toHaveLength(1)
		expect(made.recorded[0]?.error).toContain("Nowhere/Land")
		expect(made.claimed).toEqual([])
	})

	it("still fires the other triggers when reading signals fails", async () => {
		const made = harness([partsOf()], {
			signalsSince: async () => {
				throw new Error("the signal read failed")
			},
		})
		const run = await runTaskSchedulerTick(made.deps)
		expect(run.failed).toEqual([])
		expect(run.fired).toEqual([])
	})

	it("never lets a slow tick overlap the next one", async () => {
		let inFlight = 0
		let overlapped = false
		let ticks = 0
		const made = harness([], {
			enabledTasks: async () => {
				ticks += 1
				inFlight += 1
				if (inFlight > 1) overlapped = true
				await new Promise((resolve) => setTimeout(resolve, 30))
				inFlight -= 1
				return []
			},
		})
		const handle = startTaskScheduler(made.deps, 1)
		await new Promise((resolve) => setTimeout(resolve, 60))
		handle.stop()
		expect(overlapped).toBe(false)
		expect(ticks).toBeGreaterThan(0)
	})
})

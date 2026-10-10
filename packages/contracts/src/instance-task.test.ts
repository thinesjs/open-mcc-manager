import { describe, expect, it } from "vitest"
import { instanceCommandText } from "./instance"
import {
	instanceTaskInput,
	TASK_STEP_DELAY_DEFAULT_SECONDS,
	TASK_STEPS_MAX,
	TASK_TIMES_MAX,
} from "./schedule"

const task = {
	instanceId: "inst-1",
	name: "Switch to eco",
	steps: ["/economy", "/local", "/visit .ArrayIndexInOfB"],
	timezone: "Europe/London",
	onLogin: true,
}

type Overrides = Partial<{
	instanceId: string
	name: string
	steps: string[]
	stepDelaySeconds: number
	timezone: string
	onFirstLogin: boolean
	onLogin: boolean
	onLogon: boolean
	onRespawn: boolean
	times: Array<{ daysOfWeek: string[]; runAt: { hour: number; minute: number } }>
	interval: { minSeconds: number; maxSeconds: number } | null
}>

const parse = (overrides: Overrides = {}) => instanceTaskInput.safeParse({ ...task, ...overrides })

const messages = (result: ReturnType<typeof parse>): string[] =>
	result.success ? [] : result.error.issues.map((issue) => issue.message)

describe("what a task takes", () => {
	it("keeps the steps in the order they were given", () => {
		const parsed = parse()
		expect(parsed.success && parsed.data.steps).toEqual([
			"/economy",
			"/local",
			"/visit .ArrayIndexInOfB",
		])
	})

	it("defaults the gap between steps rather than leaving it unset", () => {
		const parsed = parse()
		expect(parsed.success && parsed.data.stepDelaySeconds).toBe(TASK_STEP_DELAY_DEFAULT_SECONDS)
	})

	it("reads a step the same way the console and a schedule read a command", () => {
		expect(instanceTaskInput.innerType().shape.steps.element).toBe(instanceCommandText)
	})

	it("refuses a step that spans two lines, where a task is stored rather than sent", () => {
		expect(messages(parse({ steps: ["/economy\n/local"] }))).toHaveLength(1)
	})

	it("refuses a task with no steps at all", () => {
		expect(parse({ steps: [] }).success).toBe(false)
	})

	it("refuses more steps than it will run", () => {
		expect(parse({ steps: Array.from({ length: TASK_STEPS_MAX + 1 }, () => "/hub") }).success).toBe(
			false,
		)
	})
})

describe("what a task's triggers take", () => {
	it("refuses a task no trigger would ever fire", () => {
		expect(messages(parse({ onLogin: false }))).toEqual([
			"A task needs at least one trigger, or it would never run",
		])
	})

	it("takes a task whose only trigger is a time of day", () => {
		const parsed = parse({
			onLogin: false,
			times: [{ daysOfWeek: ["Mon", "Tue"], runAt: { hour: 9, minute: 0 } }],
		})
		expect(parsed.success).toBe(true)
	})

	it("takes a task whose only trigger is an interval", () => {
		expect(
			parse({ onLogin: false, interval: { minSeconds: 3600, maxSeconds: 3600 } }).success,
		).toBe(true)
	})

	it("takes a task whose only trigger is a respawn", () => {
		expect(parse({ onLogin: false, onRespawn: true }).success).toBe(true)
	})

	it("takes first login and login together, the way MCC ORs its triggers", () => {
		expect(parse({ onFirstLogin: true, onLogin: true }).success).toBe(true)
	})

	it("refuses an interval whose shortest wait is longer than its longest", () => {
		expect(messages(parse({ interval: { minSeconds: 600, maxSeconds: 60 } }))).toEqual([
			"The shortest wait must not be longer than the longest wait",
		])
	})

	it("takes an interval whose two bounds agree, which is an exact wait", () => {
		expect(parse({ interval: { minSeconds: 3600, maxSeconds: 3600 } }).success).toBe(true)
	})

	it("refuses a time with no day, which would never come round", () => {
		expect(parse({ times: [{ daysOfWeek: [], runAt: { hour: 9, minute: 0 } }] }).success).toBe(
			false,
		)
	})

	it("refuses more times than it will hold", () => {
		const times = Array.from({ length: TASK_TIMES_MAX + 1 }, () => ({
			daysOfWeek: ["Mon"],
			runAt: { hour: 9, minute: 0 },
		}))
		expect(parse({ times }).success).toBe(false)
	})

	it("refuses a zone that does not exist rather than firing on the wrong clock", () => {
		expect(messages(parse({ timezone: "Nowhere/Land" }))).toContain(
			"That time zone does not exist. Use a name like Europe/London.",
		)
	})

	it("refuses a key it does not know, so a typo is never silently dropped", () => {
		expect(parse({ onLogon: true }).success).toBe(false)
	})
})

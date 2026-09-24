import type {
	InstanceSignalRow,
	InstanceTaskRow,
	InstanceTaskStepRow,
	InstanceTaskTimeRow,
	TaskTrigger,
} from "@open-mcc/db"
import { assertExhaustive } from "../lib/exhaustive"
import { isDue, zonedMoment } from "./due"
import { parseDaysOfWeek } from "./schedule"

export const TASK_TICK_MS = 30_000

export const TASK_SIGNAL_CATCH_UP_MS = 10 * 60 * 1000

export const TASK_RUN_RETENTION_DAYS = 7

export const TASK_RUNS_KEPT = 10

export const TASK_ABANDONED_AFTER_MS = 15 * 60 * 1000

export const TASK_ABANDONED_REASON = "The manager stopped part-way through this task"

export type TaskDefinition = {
	row: InstanceTaskRow
	steps: readonly InstanceTaskStepRow[]
	times: readonly InstanceTaskTimeRow[]
}

export type TaskClaim = {
	trigger: TaskTrigger
	claimKey: string
}

export const orderedSteps = (definition: TaskDefinition): InstanceTaskStepRow[] =>
	[...definition.steps].sort((left, right) => left.position - right.position)

export const wantsJoinSignal = (row: InstanceTaskRow): boolean => row.onFirstLogin || row.onLogin

export const wantsRespawnSignal = (row: InstanceTaskRow): boolean => row.onRespawn

export const signalClaims = (
	row: InstanceTaskRow,
	signals: readonly InstanceSignalRow[],
): TaskClaim[] => {
	const claims: TaskClaim[] = []
	const login = latestOf(signals, "login")
	const respawn = latestOf(signals, "respawn")

	if (login !== undefined && login.occurredAt.getTime() > row.createdAt.getTime()) {
		if (row.onFirstLogin && login.firstForProcess) {
			claims.push({ trigger: "firstLogin", claimKey: `firstLogin:${login.identity}` })
		}
		if (row.onLogin) claims.push({ trigger: "login", claimKey: `login:${login.identity}` })
	}

	if (
		row.onRespawn &&
		respawn !== undefined &&
		respawn.occurredAt.getTime() > row.createdAt.getTime()
	) {
		claims.push({ trigger: "respawn", claimKey: `respawn:${respawn.identity}` })
	}

	return claims
}

const latestOf = (
	signals: readonly InstanceSignalRow[],
	kind: InstanceSignalRow["kind"],
): InstanceSignalRow | undefined =>
	signals
		.filter((signal) => signal.kind === kind)
		.reduce<InstanceSignalRow | undefined>(
			(newest, signal) =>
				newest === undefined || signal.occurredAt.getTime() > newest.occurredAt.getTime()
					? signal
					: newest,
			undefined,
		)

export const timeClaims = (definition: TaskDefinition, at: Date): TaskClaim[] => {
	const claims: TaskClaim[] = []
	for (const time of definition.times) {
		const due = isDue(
			{
				daysOfWeek: parseDaysOfWeek(time.daysOfWeek),
				minuteOfDay: time.minuteOfDay,
				timezone: definition.row.timezone,
				enabled: true,
				lastRunAt: null,
			},
			at,
		)
		if (!due) continue
		const dateKey = zonedMoment(at, definition.row.timezone).dateKey
		claims.push({ trigger: "time", claimKey: `time:${dateKey}:${time.minuteOfDay}` })
	}
	return claims
}

export type IntervalArm = {
	nextRunAt: Date
	observedAt: Date
}

export type IntervalPlan =
	| { kind: "unarmed" }
	| { kind: "arm"; arm: IntervalArm }
	| { kind: "hold"; arm: IntervalArm }
	| { kind: "wait"; arm: IntervalArm }
	| { kind: "fire"; claim: TaskClaim; arm: IntervalArm }

export type IntervalJitter = (minSeconds: number, maxSeconds: number) => number

export const evenJitter: IntervalJitter = (minSeconds, maxSeconds) =>
	minSeconds >= maxSeconds
		? minSeconds
		: minSeconds + Math.floor(Math.random() * (maxSeconds - minSeconds + 1))

export const intervalPlan = (
	row: InstanceTaskRow,
	at: Date,
	running: boolean,
	jitter: IntervalJitter,
): IntervalPlan => {
	const minSeconds = row.intervalMinSeconds
	const maxSeconds = row.intervalMaxSeconds
	if (minSeconds === null || maxSeconds === null) return { kind: "unarmed" }

	const rearmed = (): IntervalArm => ({
		nextRunAt: new Date(at.getTime() + jitter(minSeconds, maxSeconds) * 1000),
		observedAt: at,
	})

	const armed = row.intervalNextRunAt
	const observed = row.intervalObservedAt
	if (armed === null || observed === null) return { kind: "arm", arm: rearmed() }

	if (!running) {
		const paused = Math.max(0, at.getTime() - observed.getTime())
		return { kind: "hold", arm: { nextRunAt: new Date(armed.getTime() + paused), observedAt: at } }
	}

	if (at.getTime() < armed.getTime()) {
		return { kind: "wait", arm: { nextRunAt: armed, observedAt: at } }
	}

	return {
		kind: "fire",
		claim: { trigger: "interval", claimKey: `interval:${armed.toISOString()}` },
		arm: rearmed(),
	}
}

export const intervalClaimOf = (plan: IntervalPlan): TaskClaim | undefined => {
	switch (plan.kind) {
		case "unarmed":
			return undefined
		case "arm":
		case "hold":
		case "wait":
			return undefined
		case "fire":
			return plan.claim
		default:
			return assertExhaustive(plan)
	}
}

export const intervalArmOf = (plan: IntervalPlan): IntervalArm | undefined => {
	switch (plan.kind) {
		case "unarmed":
			return undefined
		case "arm":
		case "hold":
		case "wait":
		case "fire":
			return plan.arm
		default:
			return assertExhaustive(plan)
	}
}

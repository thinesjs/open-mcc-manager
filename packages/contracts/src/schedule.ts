import { z } from "zod"
import { instanceCommandText } from "./instance"

export const DAYS_OF_WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const

export const dayOfWeekSchema = z.enum(DAYS_OF_WEEK)
export type DayOfWeek = z.infer<typeof dayOfWeekSchema>

export const MINUTES_PER_DAY = 24 * 60

export const timeOfDaySchema = z.object({
	hour: z.number().int().min(0).max(23),
	minute: z.number().int().min(0).max(59),
})
export type TimeOfDay = z.infer<typeof timeOfDaySchema>

export const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9+_-]*(?:\/[A-Za-z0-9+_-]+){0,2}$/

const UNKNOWN_TIMEZONE = "That time zone does not exist. Use a name like Europe/London."

const isKnownTimezone = (value: string): boolean => {
	try {
		const resolved = Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone
		return resolved === value || resolved.toLowerCase() !== value.toLowerCase()
	} catch {
		return false
	}
}

const timezoneSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(TIMEZONE_PATTERN, UNKNOWN_TIMEZONE)
	.refine(isKnownTimezone, UNKNOWN_TIMEZONE)

export const sleepWindowInput = z
	.object({
		instanceId: z.string().min(1),
		daysOfWeek: z.array(dayOfWeekSchema).min(1).max(7),
		stopAt: timeOfDaySchema,
		startAt: timeOfDaySchema,
		timezone: timezoneSchema,
	})
	.strict()
	.refine(
		(value) => minuteOfDay(value.stopAt) !== minuteOfDay(value.startAt),
		"A sleep window that stops and starts at the same minute would never end",
	)
export type SleepWindowInput = z.infer<typeof sleepWindowInput>

export const minuteOfDay = (time: TimeOfDay): number => time.hour * 60 + time.minute

export const timeOfDay = (minutes: number): TimeOfDay => ({
	hour: Math.floor(minutes / 60),
	minute: minutes % 60,
})

export const sleepWindowPublic = z.object({
	id: z.string(),
	instanceId: z.string(),
	daysOfWeek: z.array(dayOfWeekSchema),
	stopAt: timeOfDaySchema,
	startAt: timeOfDaySchema,
	timezone: z.string(),
	enabled: z.boolean(),
})
export type SleepWindowPublic = z.infer<typeof sleepWindowPublic>

export const scheduledCommandInput = z
	.object({
		instanceId: z.string().min(1),
		name: z.string().min(1).max(64),
		command: instanceCommandText,
		daysOfWeek: z.array(dayOfWeekSchema).min(1).max(7),
		runAt: timeOfDaySchema,
		timezone: timezoneSchema,
		enabled: z.boolean().default(true),
	})
	.strict()
export type ScheduledCommandInput = z.infer<typeof scheduledCommandInput>

export const scheduledCommandPublic = z.object({
	id: z.string(),
	instanceId: z.string(),
	name: z.string(),
	command: z.string(),
	daysOfWeek: z.array(dayOfWeekSchema),
	runAt: timeOfDaySchema,
	timezone: z.string(),
	enabled: z.boolean(),
	lastRunAt: z.string().datetime().nullable(),
	lastRunError: z.string().nullable(),
})
export type ScheduledCommandPublic = z.infer<typeof scheduledCommandPublic>

export const TASK_STEPS_MAX = 10

export const TASK_TIMES_MAX = 12

export const TASK_STEP_DELAY_DEFAULT_SECONDS = 3

export const TASK_STEP_DELAY_MAX_SECONDS = 60

export const TASK_INTERVAL_MIN_SECONDS = 5

export const TASK_INTERVAL_MAX_SECONDS = 30 * 24 * 60 * 60

export const TASK_TRIGGERS = ["firstLogin", "login", "respawn", "time", "interval"] as const

export const taskTriggerSchema = z.enum(TASK_TRIGGERS)
export type TaskTrigger = z.infer<typeof taskTriggerSchema>

export const TASK_RUN_OUTCOMES = ["running", "sent", "failed", "abandoned"] as const

export const taskRunOutcomeSchema = z.enum(TASK_RUN_OUTCOMES)
export type TaskRunOutcome = z.infer<typeof taskRunOutcomeSchema>

export const taskTimeSchema = z.object({
	daysOfWeek: z.array(dayOfWeekSchema).min(1).max(7),
	runAt: timeOfDaySchema,
})
export type TaskTime = z.infer<typeof taskTimeSchema>

const INTERVAL_BACKWARDS = "The shortest wait must not be longer than the longest wait"

export const taskIntervalSchema = z
	.object({
		minSeconds: z.number().int().min(TASK_INTERVAL_MIN_SECONDS).max(TASK_INTERVAL_MAX_SECONDS),
		maxSeconds: z.number().int().min(TASK_INTERVAL_MIN_SECONDS).max(TASK_INTERVAL_MAX_SECONDS),
	})
	.strict()
	.refine((value) => value.minSeconds <= value.maxSeconds, INTERVAL_BACKWARDS)
export type TaskInterval = z.infer<typeof taskIntervalSchema>

const TASK_WITHOUT_TRIGGER = "A task needs at least one trigger, or it would never run"

export const instanceTaskInput = z
	.object({
		id: z.string().min(1).nullable().default(null),
		instanceId: z.string().min(1),
		name: z.string().min(1).max(64),
		steps: z.array(instanceCommandText).min(1).max(TASK_STEPS_MAX),
		stepDelaySeconds: z
			.number()
			.int()
			.min(0)
			.max(TASK_STEP_DELAY_MAX_SECONDS)
			.default(TASK_STEP_DELAY_DEFAULT_SECONDS),
		enabled: z.boolean().default(true),
		timezone: timezoneSchema,
		onFirstLogin: z.boolean().default(false),
		onLogin: z.boolean().default(false),
		onRespawn: z.boolean().default(false),
		times: z.array(taskTimeSchema).max(TASK_TIMES_MAX).default([]),
		interval: taskIntervalSchema.nullable().default(null),
	})
	.strict()
	.refine(
		(value) =>
			value.onFirstLogin ||
			value.onLogin ||
			value.onRespawn ||
			value.times.length > 0 ||
			value.interval !== null,
		TASK_WITHOUT_TRIGGER,
	)
export type InstanceTaskInput = z.infer<typeof instanceTaskInput>

export const instanceTaskStepPublic = z.object({
	position: z.number().int(),
	command: z.string(),
})
export type InstanceTaskStepPublic = z.infer<typeof instanceTaskStepPublic>

export const instanceTaskRunPublic = z.object({
	id: z.string(),
	trigger: taskTriggerSchema,
	outcome: taskRunOutcomeSchema,
	startedAt: z.string().datetime(),
	finishedAt: z.string().datetime().nullable(),
	stepsSent: z.number().int(),
	error: z.string().nullable(),
})
export type InstanceTaskRunPublic = z.infer<typeof instanceTaskRunPublic>

export const instanceTaskPublic = z.object({
	id: z.string(),
	instanceId: z.string(),
	name: z.string(),
	steps: z.array(instanceTaskStepPublic),
	stepDelaySeconds: z.number().int(),
	enabled: z.boolean(),
	timezone: z.string(),
	onFirstLogin: z.boolean(),
	onLogin: z.boolean(),
	onRespawn: z.boolean(),
	times: z.array(taskTimeSchema),
	interval: taskIntervalSchema.nullable(),
	nextIntervalRunAt: z.string().datetime().nullable(),
	lastRunAt: z.string().datetime().nullable(),
	lastRunError: z.string().nullable(),
	runs: z.array(instanceTaskRunPublic),
})
export type InstanceTaskPublic = z.infer<typeof instanceTaskPublic>

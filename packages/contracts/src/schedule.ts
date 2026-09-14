import { z } from "zod"

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
		Intl.DateTimeFormat("en-US", { timeZone: value })
		return true
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

export const INSTANCE_COMMAND_MAX_BYTES = 256

export const instanceCommandText = z
	.string()
	.min(1)
	.max(INSTANCE_COMMAND_MAX_BYTES)
	.refine((value) => !/[\n\r]/.test(value), "A scheduled command must be a single line")

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
	lastRunAt: z.date().nullable(),
	lastRunError: z.string().nullable(),
})
export type ScheduledCommandPublic = z.infer<typeof scheduledCommandPublic>

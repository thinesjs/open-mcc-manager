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

export const sleepWindowInput = z
	.object({
		instanceId: z.string().min(1),
		daysOfWeek: z.array(dayOfWeekSchema).min(1).max(7),
		stopAt: timeOfDaySchema,
		startAt: timeOfDaySchema,
		timezone: z.string().min(1).max(64).regex(TIMEZONE_PATTERN, "Expected an IANA timezone name"),
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

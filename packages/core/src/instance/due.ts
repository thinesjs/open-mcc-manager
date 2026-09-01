import type { DayOfWeek } from "@open-mcc/contracts"
import { DAYS_OF_WEEK } from "@open-mcc/contracts"

export const CATCH_UP_GRACE_MINUTES = 60

export type ZonedMoment = {
	weekday: DayOfWeek
	minuteOfDay: number
	dateKey: string
}

const WEEKDAY_BY_SHORT_NAME: Record<string, DayOfWeek> = {
	Mon: "Mon",
	Tue: "Tue",
	Wed: "Wed",
	Thu: "Thu",
	Fri: "Fri",
	Sat: "Sat",
	Sun: "Sun",
}

export class UnknownTimezoneError extends Error {}

export const zonedMoment = (at: Date, timezone: string): ZonedMoment => {
	let parts: Intl.DateTimeFormatPart[]
	try {
		parts = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			weekday: "short",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).formatToParts(at)
	} catch {
		throw new UnknownTimezoneError(`Unknown timezone: ${timezone}`)
	}

	const find = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((part) => part.type === type)?.value ?? ""

	const weekday = WEEKDAY_BY_SHORT_NAME[find("weekday")]
	if (!weekday) throw new UnknownTimezoneError(`Unknown weekday for timezone: ${timezone}`)

	return {
		weekday,
		minuteOfDay: Number(find("hour")) * 60 + Number(find("minute")),
		dateKey: `${find("year")}-${find("month")}-${find("day")}`,
	}
}

export type DueCandidate = {
	daysOfWeek: readonly DayOfWeek[]
	minuteOfDay: number
	timezone: string
	enabled: boolean
	lastRunAt: Date | null
}

export const isDue = (candidate: DueCandidate, at: Date): boolean => {
	if (!candidate.enabled) return false
	if (candidate.daysOfWeek.length === 0) return false

	const now = zonedMoment(at, candidate.timezone)
	if (!candidate.daysOfWeek.includes(now.weekday)) return false

	const elapsed = now.minuteOfDay - candidate.minuteOfDay
	if (elapsed < 0 || elapsed > CATCH_UP_GRACE_MINUTES) return false

	if (candidate.lastRunAt === null) return true
	return zonedMoment(candidate.lastRunAt, candidate.timezone).dateKey !== now.dateKey
}

export const everyDay = (): DayOfWeek[] => [...DAYS_OF_WEEK]

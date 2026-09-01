import {
	DAYS_OF_WEEK,
	type DayOfWeek,
	minuteOfDay,
	type SleepWindowPublic,
	TIMEZONE_PATTERN,
} from "@open-mcc/contracts"
import { validateInstanceId } from "./unit"

export const SLEEP_STOP_UNIT = "open-mcc-sleep-stop"
export const SLEEP_START_UNIT = "open-mcc-sleep-start"

export const sleepStopTimer = (instanceId: string): string =>
	`${SLEEP_STOP_UNIT}@${validateInstanceId(instanceId)}.timer`

export const sleepStartTimer = (instanceId: string): string =>
	`${SLEEP_START_UNIT}@${validateInstanceId(instanceId)}.timer`

export const validateTimezone = (timezone: string): string => {
	if (!TIMEZONE_PATTERN.test(timezone) || timezone.length > 64) {
		throw new Error(`Refusing to render a timer for an unrecognised timezone: ${timezone}`)
	}
	return timezone
}

const orderedDays = (days: readonly DayOfWeek[]): DayOfWeek[] =>
	DAYS_OF_WEEK.filter((day) => days.includes(day))

export const renderDaysOfWeek = (days: readonly DayOfWeek[]): string => {
	const ordered = orderedDays(days)
	if (ordered.length === 0) throw new Error("A sleep window must name at least one day")
	return ordered.length === DAYS_OF_WEEK.length ? "*" : ordered.join(",")
}

export const calendarWeekdayPrefix = (days: readonly DayOfWeek[]): string => {
	const ordered = orderedDays(days)
	if (ordered.length === 0) throw new Error("A sleep window must name at least one day")
	return ordered.length === DAYS_OF_WEEK.length ? "" : `${ordered.join(",")} `
}

export const parseDaysOfWeek = (stored: string): DayOfWeek[] =>
	stored === "*" ? [...DAYS_OF_WEEK] : orderedDays(stored.split(",").filter(isDayOfWeek))

const isDayOfWeek = (value: string): value is DayOfWeek => DAYS_OF_WEEK.some((day) => day === value)

export const renderOnCalendar = (
	days: readonly DayOfWeek[],
	minutes: number,
	timezone: string,
): string => {
	const hour = Math.floor(minutes / 60)
	const minute = minutes % 60
	const pad = (value: number) => String(value).padStart(2, "0")
	return `${calendarWeekdayPrefix(days)}*-*-* ${pad(hour)}:${pad(minute)}:00 ${validateTimezone(timezone)}`
}

export type RenderableSleepWindow = Omit<SleepWindowPublic, "daysOfWeek"> & {
	daysOfWeek: readonly DayOfWeek[]
}

export const renderSleepTimers = (window: RenderableSleepWindow): Record<string, string> => {
	const instanceId = validateInstanceId(window.instanceId)
	const stop = renderOnCalendar(window.daysOfWeek, minuteOfDay(window.stopAt), window.timezone)
	const start = renderOnCalendar(window.daysOfWeek, minuteOfDay(window.startAt), window.timezone)

	return {
		[`${SLEEP_STOP_UNIT}@${instanceId}.timer`]: timerUnit("Sleep window stop", stop, instanceId),
		[`${SLEEP_START_UNIT}@${instanceId}.timer`]: timerUnit("Sleep window start", start, instanceId),
	}
}

const timerUnit = (description: string, onCalendar: string, instanceId: string): string =>
	`[Unit]
Description=${description} for open-mcc instance ${instanceId}

[Timer]
OnCalendar=${onCalendar}
Persistent=false
AccuracySec=30s

[Install]
WantedBy=timers.target
`

import {
	type Availability,
	BUCKET_SECONDS,
	type BucketAvailability,
	EMPTY_AVAILABILITY,
	RANGE_SECONDS,
	type StatusRange,
	type StatusState,
} from "@open-mcc/contracts"

export const SECONDS_PER_DAY = 24 * 60 * 60

export type RollableInterval = {
	state: StatusState
	startedAt: Date
	endedAt: Date | null
}

export type AvailabilityBucket = keyof Availability

const BUCKET_BY_STATE: Record<StatusState, AvailabilityBucket> = {
	up: "goodSeconds",
	joined: "goodSeconds",
	running: "goodSeconds",
	healthy: "goodSeconds",
	clear: "goodSeconds",
	down: "badSeconds",
	interrupted: "badSeconds",
	never_joined: "badSeconds",
	stopped_unexpected: "badSeconds",
	degraded: "degradedSeconds",
	drifting: "degradedSeconds",
	stuck: "degradedSeconds",
	suspect: "unknownSeconds",
	unknown: "unknownSeconds",
	excluded: "excludedSeconds",
	stopped_expected: "excludedSeconds",
}

export const bucketOf = (state: StatusState): AvailabilityBucket => BUCKET_BY_STATE[state]

export const startOfUtcDay = (moment: Date): Date =>
	new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate(), 0, 0, 0, 0))

export const addDays = (day: Date, count: number): Date =>
	new Date(day.getTime() + count * SECONDS_PER_DAY * 1000)

export const overlapSeconds = (
	interval: RollableInterval,
	dayStart: Date,
	dayEnd: Date,
): number => {
	const from = Math.max(interval.startedAt.getTime(), dayStart.getTime())
	const until = Math.min(interval.endedAt?.getTime() ?? dayEnd.getTime(), dayEnd.getTime())
	if (until <= from) return 0
	return Math.round((until - from) / 1000)
}

export const rollUpWindow = (
	intervals: readonly RollableInterval[],
	start: Date,
	end: Date,
): Availability =>
	intervals.reduce<Availability>((totals, interval) => {
		const seconds = overlapSeconds(interval, start, end)
		if (seconds === 0) return totals
		const bucket = bucketOf(interval.state)
		return { ...totals, [bucket]: totals[bucket] + seconds }
	}, EMPTY_AVAILABILITY)

export const rollUpDay = (intervals: readonly RollableInterval[], dayStart: Date): Availability =>
	rollUpWindow(intervals, dayStart, addDays(dayStart, 1))

export const bucketStartsFor = (range: StatusRange, now: Date): Date[] => {
	const step = BUCKET_SECONDS[range] * 1000
	const count = RANGE_SECONDS[range] / BUCKET_SECONDS[range]
	const current = Math.floor(now.getTime() / step) * step
	return Array.from({ length: count }, (_, index) => new Date(current - (count - 1 - index) * step))
}

export const rollUpBuckets = (
	intervals: readonly RollableInterval[],
	starts: readonly Date[],
	bucketSeconds: number,
): BucketAvailability[] =>
	starts.map((start) => ({
		start: start.toISOString(),
		availability: rollUpWindow(intervals, start, new Date(start.getTime() + bucketSeconds * 1000)),
	}))

export const daysBetween = (from: Date, until: Date): Date[] => {
	const days: Date[] = []
	let cursor = startOfUtcDay(from)
	const last = startOfUtcDay(until)
	while (cursor.getTime() < last.getTime()) {
		days.push(cursor)
		cursor = addDays(cursor, 1)
	}
	return days
}

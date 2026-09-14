import {
	type Availability,
	BUCKET_SECONDS,
	type BucketAvailability,
	EMPTY_AVAILABILITY,
	RANGE_SECONDS,
	type StatusRange,
	type StatusState,
} from "@open-mcc/contracts"

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

export const bucketStartsFor = (range: StatusRange, now: Date): Date[] => {
	const step = BUCKET_SECONDS[range] * 1000
	const count = RANGE_SECONDS[range] / BUCKET_SECONDS[range]
	const since = now.getTime() - RANGE_SECONDS[range] * 1000
	return Array.from({ length: count }, (_, index) => new Date(since + index * step))
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

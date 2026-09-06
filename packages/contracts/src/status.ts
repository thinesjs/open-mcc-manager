import { z } from "zod"

export const STATUS_SUBJECT_TYPES = ["organization", "host", "instance"] as const

export const statusSubjectTypeSchema = z.enum(STATUS_SUBJECT_TYPES)

export type StatusSubjectType = z.infer<typeof statusSubjectTypeSchema>

export const STATUS_DIMENSIONS = [
	"host.reachability",
	"host.service_health",
	"host.drift",
	"instance.connection",
	"instance.process",
	"instance.drift",
] as const

export const statusDimensionSchema = z.enum(STATUS_DIMENSIONS)

export type StatusDimension = z.infer<typeof statusDimensionSchema>

export const HOST_REACHABILITY_STATES = ["up", "suspect", "down", "unknown"] as const

export const INSTANCE_CONNECTION_STATES = [
	"joined",
	"interrupted",
	"never_joined",
	"down",
	"excluded",
	"unknown",
] as const

export const INSTANCE_PROCESS_STATES = [
	"running",
	"stuck",
	"stopped_expected",
	"stopped_unexpected",
	"unknown",
] as const

export const STATUS_STATES = [
	...HOST_REACHABILITY_STATES,
	...INSTANCE_CONNECTION_STATES,
	...INSTANCE_PROCESS_STATES,
	"degraded",
	"healthy",
	"drifting",
	"clear",
] as const

export const statusStateSchema = z.enum(STATUS_STATES)

export type StatusState = z.infer<typeof statusStateSchema>

export const STATUS_EVENT_KINDS = [
	"host.check_failed",
	"host.check_recovered",
	"host.unreachable",
	"host.recovered",
	"host.degraded",
	"host.healthy",
	"host.drift_started",
	"host.drift_resolved",
	"instance.joined",
	"instance.disconnected",
	"instance.reconnected",
	"instance.kicked",
	"instance.connection_lost",
	"instance.flapping",
	"instance.never_joined",
	"instance.started",
	"instance.stopped",
	"instance.unexpected_stop",
	"instance.process_recovered",
	"instance.needs_auth",
	"instance.drift_started",
	"instance.drift_resolved",
	"monitoring.gap",
] as const

export const statusEventKindSchema = z.enum(STATUS_EVENT_KINDS)

export type StatusEventKind = z.infer<typeof statusEventKindSchema>

const NOTIFYING_EVENT_KINDS: ReadonlySet<string> = new Set<StatusEventKind>([
	"host.unreachable",
	"host.drift_started",
	"instance.disconnected",
	"instance.flapping",
	"instance.never_joined",
	"instance.unexpected_stop",
	"instance.needs_auth",
	"instance.drift_started",
])

export const isNotifyingEvent = (kind: StatusEventKind): boolean => NOTIFYING_EVENT_KINDS.has(kind)

const RESOLVES: Partial<Record<StatusEventKind, StatusEventKind>> = {
	"host.recovered": "host.unreachable",
	"host.drift_resolved": "host.drift_started",
	"instance.reconnected": "instance.disconnected",
	"instance.process_recovered": "instance.unexpected_stop",
	"instance.drift_resolved": "instance.drift_started",
}

export const problemResolvedBy = (kind: StatusEventKind): StatusEventKind | undefined =>
	RESOLVES[kind]

export const FLAPPING_WINDOW_MS = 30 * 60 * 1000

export const FLAPPING_THRESHOLD = 5

export const isFlapping = (
	losses: readonly Date[],
	now: Date,
	windowMs: number = FLAPPING_WINDOW_MS,
	threshold: number = FLAPPING_THRESHOLD,
): boolean => losses.filter((at) => now.getTime() - at.getTime() <= windowMs).length >= threshold

export const STATUS_SOURCES = ["host_probe", "journal", "live_channel", "reconcile"] as const

export const statusSourceSchema = z.enum(STATUS_SOURCES)

export type StatusSource = z.infer<typeof statusSourceSchema>

export const STATUS_RANGES = ["24h", "7d", "30d"] as const

export const statusRangeSchema = z.enum(STATUS_RANGES)

export type StatusRange = z.infer<typeof statusRangeSchema>

export const rangeWithinRetention = (range: StatusRange, retentionDays: number): StatusRange => {
	const wanted = RANGE_SECONDS[range] / (24 * 60 * 60)
	if (wanted <= retentionDays) return range
	if (retentionDays >= 7) return "7d"
	return "24h"
}

export const RANGE_SECONDS: Record<StatusRange, number> = {
	"24h": 24 * 60 * 60,
	"7d": 7 * 24 * 60 * 60,
	"30d": 30 * 24 * 60 * 60,
}

export const statusSummaryInput = z.object({ range: statusRangeSchema.default("24h") })

export const statusEventsInput = z.object({
	range: statusRangeSchema.default("24h"),
	hostId: z.string().min(1).optional(),
	instanceId: z.string().min(1).optional(),
	cursor: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(100).default(50),
})

export type StatusSummaryInput = z.infer<typeof statusSummaryInput>

export type StatusEventsInput = z.infer<typeof statusEventsInput>

export const DEFAULT_STATUS_RETENTION_DAYS = 30

export const MIN_STATUS_RETENTION_DAYS = 1

export const MAX_STATUS_RETENTION_DAYS = 365

export const HOST_SUSPECT_TO_DOWN_MS = 3 * 60 * 1000

export const INSTANCE_INTERRUPTED_TO_DOWN_MS = 2 * 60 * 1000

export const INSTANCE_NEVER_JOINED_MS = 3 * 60 * 1000

export type Availability = {
	goodSeconds: number
	badSeconds: number
	degradedSeconds: number
	unknownSeconds: number
	excludedSeconds: number
}

export const EMPTY_AVAILABILITY: Availability = {
	goodSeconds: 0,
	badSeconds: 0,
	degradedSeconds: 0,
	unknownSeconds: 0,
	excludedSeconds: 0,
}

export const measuredSeconds = (availability: Availability): number =>
	availability.goodSeconds + availability.badSeconds + availability.degradedSeconds

export const uptimeRatio = (availability: Availability): number | undefined => {
	const measured = measuredSeconds(availability)
	if (measured === 0) return undefined
	return (availability.goodSeconds + availability.degradedSeconds) / measured
}

export const coverageRatio = (availability: Availability): number | undefined => {
	const observable = measuredSeconds(availability) + availability.unknownSeconds
	if (observable === 0) return undefined
	return measuredSeconds(availability) / observable
}

export type BucketAvailability = {
	start: string
	availability: Availability
}

export type HostUptime = {
	hostId: string
	hostName: string
	state: StatusState
	since: Date
	lastCheckedAt: Date
	availability: Availability
	buckets: BucketAvailability[]
}

export type BotUptime = {
	instanceId: string
	instanceName: string
	state: StatusState
	availability: Availability
	buckets: BucketAvailability[]
	lastChangeAt: Date | null
}

export type StatusSummary = {
	hosts: HostUptime[]
	bots: BotUptime[]
	answering: number
	total: number
	granularity: "hour" | "day"
	retentionDays: number
}

export const granularityFor = (range: StatusRange): "hour" | "day" =>
	range === "24h" ? "hour" : "day"

export type StatusEventView = {
	id: string
	kind: StatusEventKind
	subjectLabel: string
	hostId: string | null
	instanceId: string | null
	occurredAt: Date
}

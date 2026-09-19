import type { Insertable, Selectable, SelectType } from "kysely"
import type { DB, Generated } from "../generated/database"

export type StatusSubjectType = "organization" | "host" | "instance"

export type StatusDimension =
	| "host.reachability"
	| "host.service_health"
	| "host.drift"
	| "instance.connection"
	| "instance.process"
	| "instance.drift"

export type StatusState =
	| "up"
	| "suspect"
	| "down"
	| "unknown"
	| "joined"
	| "interrupted"
	| "never_joined"
	| "excluded"
	| "running"
	| "stuck"
	| "stopped_expected"
	| "stopped_unexpected"
	| "degraded"
	| "healthy"
	| "drifting"
	| "clear"

export type StatusSource = "host_probe" | "journal" | "live_channel" | "reconcile"

export type StatusEventKind =
	| "host.check_failed"
	| "host.check_recovered"
	| "host.unreachable"
	| "host.recovered"
	| "host.degraded"
	| "host.healthy"
	| "host.drift_started"
	| "host.drift_resolved"
	| "instance.joined"
	| "instance.disconnected"
	| "instance.reconnected"
	| "instance.kicked"
	| "instance.connection_lost"
	| "instance.flapping"
	| "instance.never_joined"
	| "instance.started"
	| "instance.stopped"
	| "instance.unexpected_stop"
	| "instance.process_recovered"
	| "instance.needs_auth"
	| "instance.drift_started"
	| "instance.drift_resolved"
	| "monitoring.gap"

type RefinementOf<Narrowed extends Base, Base> = Narrowed

type _SubjectTypeRefines = RefinementOf<
	StatusSubjectType,
	SelectType<DB["statusEvent"]["subjectType"]>
>

type _KindRefines = RefinementOf<StatusEventKind, SelectType<DB["statusEvent"]["kind"]>>

type _SourceRefines = RefinementOf<StatusSource, SelectType<DB["statusEvent"]["primarySource"]>>

type _DimensionRefines = RefinementOf<
	StatusDimension,
	SelectType<DB["statusCondition"]["dimension"]>
>

type _StateRefines = RefinementOf<StatusState, SelectType<DB["statusCondition"]["state"]>>

export type StatusEventTable = Omit<
	DB["statusEvent"],
	"subjectType" | "kind" | "primarySource" | "sources" | "detail"
> & {
	subjectType: StatusSubjectType
	kind: StatusEventKind
	primarySource: StatusSource
	sources: Generated<StatusSource[]>
	detail: Generated<DB["statusEvent"]["detail"]>
}

export type StatusEventRow = Selectable<StatusEventTable>
export type StatusEventInsert = Insertable<StatusEventTable>

export type StatusConditionTable = Omit<DB["statusCondition"], "dimension" | "state" | "detail"> & {
	dimension: StatusDimension
	state: StatusState
	detail: Generated<DB["statusCondition"]["detail"]>
}

export type StatusConditionRow = Selectable<StatusConditionTable>
export type StatusConditionInsert = Insertable<StatusConditionTable>

export type StatusIntervalTable = Omit<DB["statusInterval"], "dimension" | "state"> & {
	dimension: StatusDimension
	state: StatusState
}

export type StatusIntervalRow = Selectable<StatusIntervalTable>
export type StatusIntervalInsert = Insertable<StatusIntervalTable>

export type StatusDailyRollupTable = Omit<DB["statusDailyRollup"], "dimension"> & {
	dimension: StatusDimension
}

export type StatusDailyRollupRow = Selectable<StatusDailyRollupTable>
export type StatusDailyRollupInsert = Insertable<StatusDailyRollupTable>

export type StatusSourceCursorTable = Omit<DB["statusSourceCursor"], "source"> & {
	source: StatusSource
}

export type StatusSourceCursorRow = Selectable<StatusSourceCursorTable>
export type StatusSourceCursorInsert = Insertable<StatusSourceCursorTable>

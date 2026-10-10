import type { Insertable, Selectable, SelectType } from "kysely"
import type { DB, Generated } from "../generated/database"

type RefinementOf<Narrowed extends Base, Base> = Narrowed

export type TaskTrigger = "firstLogin" | "login" | "respawn" | "time" | "interval"

export type TaskRunOutcome = "running" | "sent" | "failed" | "abandoned"

export type InstanceSignalKind = "login" | "respawn"

export type InstanceSignalSource = "journal" | "liveEvents"

type _TaskTriggerRefinesGeneratedColumn = RefinementOf<
	TaskTrigger,
	SelectType<DB["instanceTaskRun"]["trigger"]>
>

type _TaskRunOutcomeRefinesGeneratedColumn = RefinementOf<
	TaskRunOutcome,
	SelectType<DB["instanceTaskRun"]["outcome"]>
>

type _InstanceSignalKindRefinesGeneratedColumn = RefinementOf<
	InstanceSignalKind,
	SelectType<DB["instanceSignal"]["kind"]>
>

type _InstanceSignalSourceRefinesGeneratedColumn = RefinementOf<
	InstanceSignalSource,
	SelectType<DB["instanceSignalCursor"]["source"]>
>

export type InstanceTaskTable = Omit<
	DB["instanceTask"],
	| "enabled"
	| "stepDelaySeconds"
	| "onFirstLogin"
	| "onLogin"
	| "onRespawn"
	| "intervalMinSeconds"
	| "intervalMaxSeconds"
	| "intervalNextRunAt"
	| "intervalObservedAt"
	| "lastRunAt"
	| "lastRunError"
> & {
	enabled: Generated<boolean>
	stepDelaySeconds: Generated<number>
	onFirstLogin: Generated<boolean>
	onLogin: Generated<boolean>
	onRespawn: Generated<boolean>
	intervalMinSeconds: Generated<DB["instanceTask"]["intervalMinSeconds"]>
	intervalMaxSeconds: Generated<DB["instanceTask"]["intervalMaxSeconds"]>
	intervalNextRunAt: Generated<DB["instanceTask"]["intervalNextRunAt"]>
	intervalObservedAt: Generated<DB["instanceTask"]["intervalObservedAt"]>
	lastRunAt: Generated<DB["instanceTask"]["lastRunAt"]>
	lastRunError: Generated<DB["instanceTask"]["lastRunError"]>
}

export type InstanceTaskRow = Selectable<InstanceTaskTable>
export type InstanceTaskInsert = Insertable<InstanceTaskTable>

export type InstanceTaskStepTable = DB["instanceTaskStep"]

export type InstanceTaskStepRow = Selectable<InstanceTaskStepTable>
export type InstanceTaskStepInsert = Insertable<InstanceTaskStepTable>

export type InstanceTaskTimeTable = DB["instanceTaskTime"]

export type InstanceTaskTimeRow = Selectable<InstanceTaskTimeTable>
export type InstanceTaskTimeInsert = Insertable<InstanceTaskTimeTable>

export type InstanceTaskRunTable = Omit<
	DB["instanceTaskRun"],
	"trigger" | "outcome" | "stepsSent" | "finishedAt" | "error"
> & {
	trigger: TaskTrigger
	outcome: Generated<TaskRunOutcome>
	stepsSent: Generated<number>
	finishedAt: Generated<DB["instanceTaskRun"]["finishedAt"]>
	error: Generated<DB["instanceTaskRun"]["error"]>
}

export type InstanceTaskRunRow = Selectable<InstanceTaskRunTable>
export type InstanceTaskRunInsert = Insertable<InstanceTaskRunTable>

export type InstanceSignalTable = Omit<
	DB["instanceSignal"],
	"kind" | "firstForProcess" | "observedAt"
> & {
	kind: InstanceSignalKind
	firstForProcess: Generated<boolean>
	observedAt: Generated<DB["instanceSignal"]["observedAt"]>
}

export type InstanceSignalRow = Selectable<InstanceSignalTable>
export type InstanceSignalInsert = Insertable<InstanceSignalTable>

export type InstanceSignalCursorTable = Omit<DB["instanceSignalCursor"], "source"> & {
	source: InstanceSignalSource
}

export type InstanceSignalCursorRow = Selectable<InstanceSignalCursorTable>
export type InstanceSignalCursorInsert = Insertable<InstanceSignalCursorTable>

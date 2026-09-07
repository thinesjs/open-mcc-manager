import type { Queue, QueueResult, UpdateQueueOptions } from "pg-boss"

export const NOTIFICATION_DEADLETTER_QUEUE = "notification.deadletter"

export const NOTIFICATION_HTTP_QUEUE = "notification.deliver.http"

export const NOTIFICATION_EMAIL_QUEUE = "notification.deliver.email"

const DAY_SECONDS = 24 * 60 * 60

const DELIVERY_RETENTION_SECONDS = 14 * DAY_SECONDS

const DEADLETTER_RETENTION_SECONDS = 30 * DAY_SECONDS

export type QueuePolicy = {
	readonly name: string
	readonly retryLimit: number
	readonly retryDelay: number
	readonly retryBackoff: boolean
	readonly retryDelayMax: number | null
	readonly expireInSeconds: number
	readonly retentionSeconds: number
	readonly deleteAfterSeconds: number
	readonly deadLetter: string | null
	readonly warningQueueSize: number
	readonly heartbeatSeconds: number | null
	readonly notify: boolean
}

const DELIVERY_POLICY = {
	retryLimit: 0,
	retryDelay: 0,
	retryBackoff: false,
	retryDelayMax: null,
	expireInSeconds: 5 * 60,
	retentionSeconds: DELIVERY_RETENTION_SECONDS,
	deleteAfterSeconds: DELIVERY_RETENTION_SECONDS,
	deadLetter: NOTIFICATION_DEADLETTER_QUEUE,
	warningQueueSize: 1000,
	heartbeatSeconds: null,
	notify: false,
} as const

export const NOTIFICATION_QUEUE_POLICIES: readonly QueuePolicy[] = [
	{
		name: NOTIFICATION_DEADLETTER_QUEUE,
		retryLimit: 0,
		retryDelay: 0,
		retryBackoff: false,
		retryDelayMax: null,
		expireInSeconds: 15 * 60,
		retentionSeconds: DEADLETTER_RETENTION_SECONDS,
		deleteAfterSeconds: DEADLETTER_RETENTION_SECONDS,
		deadLetter: null,
		warningQueueSize: 100,
		heartbeatSeconds: null,
		notify: false,
	},
	{ name: NOTIFICATION_HTTP_QUEUE, ...DELIVERY_POLICY },
	{ name: NOTIFICATION_EMAIL_QUEUE, ...DELIVERY_POLICY },
]

export const orderedForCreation = (policies: readonly QueuePolicy[]): readonly QueuePolicy[] => [
	...policies.filter((policy) => policy.deadLetter === null),
	...policies.filter((policy) => policy.deadLetter !== null),
]

const CONFIGURED_FIELDS = [
	"retryLimit",
	"retryDelay",
	"retryBackoff",
	"retryDelayMax",
	"expireInSeconds",
	"retentionSeconds",
	"deleteAfterSeconds",
	"deadLetter",
	"warningQueueSize",
	"heartbeatSeconds",
	"notify",
] as const

type ConfiguredField = (typeof CONFIGURED_FIELDS)[number]

export type StoredQueue = {
	readonly [Field in ConfiguredField]: Exclude<QueueResult[Field], undefined> | null
}

export type QueueCreateOptions = Required<
	Pick<
		Queue,
		| "retryLimit"
		| "retryDelay"
		| "retryBackoff"
		| "expireInSeconds"
		| "retentionSeconds"
		| "deleteAfterSeconds"
		| "warningQueueSize"
		| "notify"
	>
> &
	Partial<Pick<Queue, "retryDelayMax" | "deadLetter" | "heartbeatSeconds">>

export type QueueUpdateOptions = Required<
	Pick<
		UpdateQueueOptions,
		| "retryLimit"
		| "retryDelay"
		| "retryBackoff"
		| "retryDelayMax"
		| "expireInSeconds"
		| "retentionSeconds"
		| "deleteAfterSeconds"
		| "deadLetter"
		| "warningQueueSize"
		| "heartbeatSeconds"
		| "notify"
	>
>

type RefinementOf<Narrowed extends Base, Base> = Narrowed

type _CreateOptionsFitPgBoss = RefinementOf<QueueCreateOptions, Omit<Queue, "name">>

type _UpdateOptionsFitPgBoss = RefinementOf<QueueUpdateOptions, UpdateQueueOptions>

export type QueueAdmin = {
	createQueue: (name: string, options: QueueCreateOptions) => Promise<void>
	updateQueue: (name: string, options: QueueUpdateOptions) => Promise<void>
	getQueue: (name: string) => Promise<StoredQueue | null>
}

export type QueueSource = {
	createQueue: (name: string, options: QueueCreateOptions) => Promise<void>
	updateQueue: (name: string, options: QueueUpdateOptions) => Promise<void>
	getQueue: (name: string) => Promise<QueueResult | null>
}

export const storedFrom = (queue: QueueResult): StoredQueue => ({
	retryLimit: queue.retryLimit ?? null,
	retryDelay: queue.retryDelay ?? null,
	retryBackoff: queue.retryBackoff ?? null,
	retryDelayMax: queue.retryDelayMax ?? null,
	expireInSeconds: queue.expireInSeconds ?? null,
	retentionSeconds: queue.retentionSeconds ?? null,
	deleteAfterSeconds: queue.deleteAfterSeconds ?? null,
	deadLetter: queue.deadLetter ?? null,
	warningQueueSize: queue.warningQueueSize ?? null,
	heartbeatSeconds: queue.heartbeatSeconds ?? null,
	notify: queue.notify ?? null,
})

export const adminFor = (source: QueueSource): QueueAdmin => ({
	createQueue: source.createQueue,
	updateQueue: source.updateQueue,
	getQueue: async (name) => {
		const found = await source.getQueue(name)
		return found === null ? null : storedFrom(found)
	},
})

export const createOptionsOf = (policy: QueuePolicy): QueueCreateOptions => ({
	retryLimit: policy.retryLimit,
	retryDelay: policy.retryDelay,
	retryBackoff: policy.retryBackoff,
	expireInSeconds: policy.expireInSeconds,
	retentionSeconds: policy.retentionSeconds,
	deleteAfterSeconds: policy.deleteAfterSeconds,
	warningQueueSize: policy.warningQueueSize,
	notify: policy.notify,
	...(policy.retryDelayMax === null ? {} : { retryDelayMax: policy.retryDelayMax }),
	...(policy.deadLetter === null ? {} : { deadLetter: policy.deadLetter }),
	...(policy.heartbeatSeconds === null ? {} : { heartbeatSeconds: policy.heartbeatSeconds }),
})

export const updateOptionsOf = (policy: QueuePolicy): QueueUpdateOptions => ({
	retryLimit: policy.retryLimit,
	retryDelay: policy.retryDelay,
	retryBackoff: policy.retryBackoff,
	retryDelayMax: policy.retryDelayMax,
	expireInSeconds: policy.expireInSeconds,
	retentionSeconds: policy.retentionSeconds,
	deleteAfterSeconds: policy.deleteAfterSeconds,
	deadLetter: policy.deadLetter,
	warningQueueSize: policy.warningQueueSize,
	heartbeatSeconds: policy.heartbeatSeconds,
	notify: policy.notify,
})

export const configuredAs = (policy: QueuePolicy): StoredQueue => ({
	retryLimit: policy.retryLimit,
	retryDelay: policy.retryDelay,
	retryBackoff: policy.retryBackoff,
	retryDelayMax: policy.retryDelayMax,
	expireInSeconds: policy.expireInSeconds,
	retentionSeconds: policy.retentionSeconds,
	deleteAfterSeconds: policy.deleteAfterSeconds,
	deadLetter: policy.deadLetter,
	warningQueueSize: policy.warningQueueSize,
	heartbeatSeconds: policy.heartbeatSeconds,
	notify: policy.notify,
})

export const fieldThatDisagrees = (
	stored: StoredQueue,
	configured: StoredQueue,
): ConfiguredField | undefined =>
	CONFIGURED_FIELDS.find((field) => stored[field] !== configured[field])

export const reconcileQueues = async (
	admin: QueueAdmin,
	policies: readonly QueuePolicy[] = NOTIFICATION_QUEUE_POLICIES,
): Promise<void> => {
	for (const policy of orderedForCreation(policies)) {
		await admin.createQueue(policy.name, createOptionsOf(policy))
		await admin.updateQueue(policy.name, updateOptionsOf(policy))

		const stored = await admin.getQueue(policy.name)
		if (stored === null) throw new Error(`queue ${policy.name} was not created`)

		const configured = configuredAs(policy)
		const field = fieldThatDisagrees(stored, configured)
		if (field !== undefined)
			throw new Error(
				`queue ${policy.name} reports ${field} as ${String(stored[field])}, not the configured ${String(configured[field])}`,
			)
	}
}

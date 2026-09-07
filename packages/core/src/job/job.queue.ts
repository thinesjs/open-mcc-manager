import type { Executor } from "@open-mcc/db"
import { asSqlRunner, type SqlRunner } from "./executor-adapter"
import {
	NOTIFICATION_CLEANUP_QUEUE,
	NOTIFICATION_DEADLETTER_QUEUE,
	NOTIFICATION_EMAIL_QUEUE,
	NOTIFICATION_HTTP_QUEUE,
	STATUS_ESCALATE_QUEUE,
} from "./queue-setup"

export const HOST_TEARDOWN_QUEUE = "host.teardown"

export const QUEUE_NAMES = [
	HOST_TEARDOWN_QUEUE,
	STATUS_ESCALATE_QUEUE,
	NOTIFICATION_CLEANUP_QUEUE,
	NOTIFICATION_HTTP_QUEUE,
	NOTIFICATION_EMAIL_QUEUE,
	NOTIFICATION_DEADLETTER_QUEUE,
] as const

export type QueueName = (typeof QUEUE_NAMES)[number]

export type SendJobOptions = { startAfterSeconds: number }

export type SendJob = (
	queue: QueueName,
	payload: Record<string, string>,
	runner: SqlRunner,
	options?: SendJobOptions,
) => Promise<string | null>

export type JobQueue = {
	enqueue: (queue: QueueName, payload: Record<string, string>) => Promise<void>
}

export const createJobQueue = (send: SendJob, executor: Executor): JobQueue => ({
	enqueue: async (queue, payload) => {
		await send(queue, payload, asSqlRunner(executor))
	},
})

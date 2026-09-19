import type { Executor } from "@open-mcc/db"
import { asSqlRunner, type SqlRunner } from "./executor-adapter"
import {
	HOST_TEARDOWN_QUEUE,
	NOTIFICATION_CLEANUP_QUEUE,
	NOTIFICATION_DEADLETTER_QUEUE,
	NOTIFICATION_EMAIL_QUEUE,
	NOTIFICATION_HTTP_QUEUE,
	STATUS_ESCALATE_QUEUE,
	SYSTEM_UPDATE_CHECK_QUEUE,
} from "./queue-setup"

export const QUEUE_NAMES = [
	HOST_TEARDOWN_QUEUE,
	STATUS_ESCALATE_QUEUE,
	NOTIFICATION_CLEANUP_QUEUE,
	NOTIFICATION_HTTP_QUEUE,
	NOTIFICATION_EMAIL_QUEUE,
	NOTIFICATION_DEADLETTER_QUEUE,
	SYSTEM_UPDATE_CHECK_QUEUE,
] as const

export type QueueName = (typeof QUEUE_NAMES)[number]

export type SendJobOptions = { startAfterSeconds: number }

export type SendJob = (
	queue: QueueName,
	payload: Record<string, string>,
	runner: SqlRunner,
	options?: SendJobOptions,
) => Promise<string | null>

export class JobNotQueuedError extends Error {}

export type JobQueue = {
	enqueue: (queue: QueueName, payload: Record<string, string>) => Promise<void>
}

export const createJobQueue = (send: SendJob, executor: Executor): JobQueue => ({
	enqueue: async (queue, payload) => {
		let jobId: string | null
		try {
			jobId = await send(queue, payload, asSqlRunner(executor))
		} catch (error) {
			if (!(error instanceof Error) || error.constructor !== Error) throw error
			throw new JobNotQueuedError(error.message)
		}
		if (jobId === null) throw new JobNotQueuedError(`${queue} did not take the job`)
	},
})

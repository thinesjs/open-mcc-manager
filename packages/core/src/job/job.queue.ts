import type { Executor } from "@open-mcc/db"
import { asSqlRunner, type SqlRunner } from "./executor-adapter"

export const HOST_TEARDOWN_QUEUE = "host.teardown"

export const QUEUE_NAMES = [HOST_TEARDOWN_QUEUE] as const

export type QueueName = (typeof QUEUE_NAMES)[number]

export type SendJob = (
	queue: QueueName,
	payload: Record<string, string>,
	runner: SqlRunner,
) => Promise<string | null>

export type JobQueue = {
	enqueue: (queue: QueueName, payload: Record<string, string>) => Promise<void>
}

export const createJobQueue = (send: SendJob, executor: Executor): JobQueue => ({
	enqueue: async (queue, payload) => {
		await send(queue, payload, asSqlRunner(executor))
	},
})

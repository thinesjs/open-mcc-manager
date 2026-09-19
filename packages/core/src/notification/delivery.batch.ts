import { inCarriedSpan } from "../log/job-span"
import type { Logger } from "../log/logger"
import type { DeliveryPayload, DeliveryResult } from "./delivery.job"
import { readDeliveryPayload } from "./delivery.job"

type QueuedJob = { readonly id: string; readonly data: object }

type DeliverOne = (payload: DeliveryPayload) => Promise<DeliveryResult>

export type MalformedJobReporter = (queue: string, jobId: string) => void

export const malformedJobReporter =
	(logger: Pick<Logger, "warn">): MalformedJobReporter =>
	(queue, jobId) =>
		logger.warn("Discarded a malformed delivery job", { queue, job_id: jobId })

export const deliverQueuedBatch = async (
	queue: string,
	jobs: readonly QueuedJob[],
	deliver: DeliverOne,
	reportMalformed: MalformedJobReporter,
): Promise<void> => {
	for (const job of jobs) {
		const payload = readDeliveryPayload(job.data)
		if (!payload) {
			reportMalformed(queue, job.id)
			continue
		}
		const carrier = payload.traceparent === undefined ? {} : { traceparent: payload.traceparent }
		await inCarriedSpan(
			`deliver ${queue}`,
			carrier,
			{
				"messaging.system": "pg-boss",
				"messaging.destination.name": queue,
				"messaging.message.id": job.id,
				"messaging.message.conversation_id": payload.deliveryId,
				"delivery.attempt": payload.attempt,
			},
			async (span) => {
				const result = await deliver(payload)
				span.setAttribute("delivery.outcome", result.settled)
				return result
			},
		)
	}
}

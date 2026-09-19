import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import {
	InMemorySpanExporter,
	NodeTracerProvider,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node"
import { afterAll, describe, expect, it } from "vitest"
import { createLogger } from "../log/logger"
import { activeTraceIds, carrierForActiveContext } from "../log/tracing"
import { deliverQueuedBatch, malformedJobReporter } from "./delivery.batch"
import type { DeliveryPayload, DeliveryResult } from "./delivery.job"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
provider.register()

const QUEUE = "notification.deliver.http"

const delivered: DeliveryResult = { settled: "delivered" }

const job = (id: string, data: Record<string, string>) => ({ id, data })

const ignoreMalformed = () => undefined

const payloadFor = (deliveryId: string) => ({
	organizationId: "org_1",
	deliveryId,
	attempt: "2",
})

describe("delivering a batch of queued jobs", () => {
	afterAll(async () => {
		await provider.shutdown()
	})

	const spanFor = async (
		jobs: readonly { id: string; data: object }[],
		deliver: (payload: DeliveryPayload) => Promise<DeliveryResult> = async () => delivered,
	) => {
		exporter.reset()
		await deliverQueuedBatch(QUEUE, jobs, deliver, ignoreMalformed)
		return exporter.getFinishedSpans().find((each) => each.name === `deliver ${QUEUE}`)
	}

	it("names the queue message and the delivery separately, because a retry is a new message", async () => {
		const span = await spanFor([job("job_99", payloadFor("dlv_1"))])

		expect(span?.attributes["messaging.message.id"]).toBe("job_99")
		expect(span?.attributes["messaging.message.conversation_id"]).toBe("dlv_1")
		expect(span?.attributes["messaging.system"]).toBe("pg-boss")
		expect(span?.attributes["messaging.destination.name"]).toBe(QUEUE)
		expect(span?.attributes["delivery.attempt"]).toBe(2)
	})

	it("runs the job inside a consumer span, not an internal one", async () => {
		const span = await spanFor([job("job_1", payloadFor("dlv_1"))])
		expect(span?.kind).toBe(SpanKind.CONSUMER)
	})

	it("records what the delivery settled as", async () => {
		const span = await spanFor([job("job_1", payloadFor("dlv_1"))], async () => ({
			settled: "retrying",
			afterSeconds: 45,
		}))
		expect(span?.attributes["delivery.outcome"]).toBe("retrying")
	})

	it("joins the trace of whoever enqueued the job", async () => {
		const tracer = trace.getTracer("enqueue")
		const carried = tracer.startActiveSpan("enqueue", (span) => {
			const written = carrierForActiveContext()
			span.end()
			return written
		})

		const span = await spanFor([job("job_1", { ...payloadFor("dlv_1"), ...carried })])

		const parent = carried.traceparent?.split("-")
		expect(span?.spanContext().traceId).toBe(parent?.[1])
		expect(span?.parentSpanContext?.spanId).toBe(parent?.[2])
	})

	it("runs the delivery inside the consumer span, so its logs and db spans correlate", async () => {
		const tracer = trace.getTracer("enqueue")
		const carried = tracer.startActiveSpan("enqueue", (span) => {
			const written = carrierForActiveContext()
			span.end()
			return written
		})

		exporter.reset()
		let inside: { trace_id: string; span_id: string } | undefined
		let sawTraceparent: string | undefined
		await deliverQueuedBatch(
			QUEUE,
			[job("job_1", { ...payloadFor("dlv_1"), ...carried })],
			async (payload) => {
				inside = activeTraceIds()
				sawTraceparent = payload.traceparent
				return delivered
			},
			ignoreMalformed,
		)

		const span = exporter.getFinishedSpans().find((each) => each.name === `deliver ${QUEUE}`)

		expect(inside).toBeDefined()
		expect(inside?.trace_id).toBe(span?.spanContext().traceId)
		expect(inside?.span_id).toBe(span?.spanContext().spanId)
		expect(sawTraceparent).toBe(carried.traceparent)
	})

	it("marks the span an error when the delivery throws, rather than ending it ok", async () => {
		exporter.reset()

		await expect(
			deliverQueuedBatch(
				QUEUE,
				[job("job_1", payloadFor("dlv_1"))],
				async () => {
					throw new Error("the smtp server hung up")
				},
				ignoreMalformed,
			),
		).rejects.toThrow("the smtp server hung up")

		const span = exporter.getFinishedSpans().find((each) => each.name === `deliver ${QUEUE}`)
		expect(span?.status.code).toBe(SpanStatusCode.ERROR)
	})

	it("skips a malformed job without failing the rest of the batch", async () => {
		const seen: string[] = []
		exporter.reset()
		await deliverQueuedBatch(
			QUEUE,
			[job("job_bad", { nothing: "useful" }), job("job_ok", payloadFor("dlv_2"))],
			async (payload) => {
				seen.push(payload.deliveryId)
				return delivered
			},
			ignoreMalformed,
		)

		expect(seen).toEqual(["dlv_2"])
		expect(exporter.getFinishedSpans().filter((s) => s.name === `deliver ${QUEUE}`)).toHaveLength(1)
	})

	it("reports a malformed job by queue and id rather than discarding it silently", async () => {
		const reported: { queue: string; jobId: string }[] = []
		exporter.reset()

		await deliverQueuedBatch(
			QUEUE,
			[job("job_bad", { nothing: "useful" }), job("job_ok", payloadFor("dlv_3"))],
			async () => delivered,
			(queue, jobId) => reported.push({ queue, jobId }),
		)

		expect(reported).toEqual([{ queue: QUEUE, jobId: "job_bad" }])
	})
	it("logs the discarded job at warn, with the queue and the job id an operator can chase", async () => {
		const lines: string[] = []
		const logger = createLogger({ level: "debug", write: (line) => lines.push(line) })
		exporter.reset()

		await deliverQueuedBatch(
			QUEUE,
			[job("job_bad", { nothing: "useful" })],
			async () => delivered,
			malformedJobReporter(logger),
		)

		const entry = JSON.parse(lines[0] ?? "{}")
		expect(entry.level).toBe("warn")
		expect(entry.message).toBe("Discarded a malformed delivery job")
		expect(entry.queue).toBe(QUEUE)
		expect(entry.job_id).toBe("job_bad")
	})
})

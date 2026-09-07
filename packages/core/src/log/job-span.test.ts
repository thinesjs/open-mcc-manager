import { trace } from "@opentelemetry/api"
import { afterAll, describe, expect, it } from "vitest"
import { inCarriedSpan } from "./job-span"
import { activeTraceIds, carrierForActiveContext, startTracing, TRACEPARENT } from "./tracing"

describe("the span a queued job runs inside", () => {
	const handle = startTracing({ service: "job", endpoint: "http://127.0.0.1:4318" })

	afterAll(async () => {
		await handle.shutdown()
	})

	const enqueued = () => {
		const tracer = trace.getTracer("job")
		return tracer.startActiveSpan("enqueue", (span) => {
			const ids = activeTraceIds()
			const carrier = carrierForActiveContext()
			span.end()
			return { ids, carrier }
		})
	}

	it("joins the trace of whoever enqueued the job", async () => {
		const { ids, carrier } = enqueued()

		const seen = await inCarriedSpan("deliver", carrier, {}, async () => activeTraceIds())

		expect(seen?.trace_id).toBe(ids?.trace_id)
		expect(seen?.span_id).not.toBe(ids?.span_id)
	})

	it("still runs, in a trace of its own, when the job carries no context", async () => {
		const seen = await inCarriedSpan("deliver", {}, {}, async () => activeTraceIds())

		expect(seen).toBeDefined()
		expect(seen?.trace_id).toMatch(/^[0-9a-f]{32}$/)
	})

	it("starts a fresh trace rather than throwing when the traceparent is malformed", async () => {
		for (const bad of ["nonsense", "00-tooshort-x-01"]) {
			const seen = await inCarriedSpan("deliver", { [TRACEPARENT]: bad }, {}, async () =>
				activeTraceIds(),
			)
			expect(seen?.trace_id).toMatch(/^[0-9a-f]{32}$/)
		}
	})

	it("hands back what the job returned", async () => {
		const result = await inCarriedSpan("deliver", {}, {}, async () => ({ settled: "delivered" }))
		expect(result).toEqual({ settled: "delivered" })
	})

	it("lets the job record its outcome on the span it was given", async () => {
		const recorded = await inCarriedSpan("deliver", {}, {}, async (span) => {
			span.setAttribute("delivery.outcome", "retrying")
			return true
		})
		expect(recorded).toBe(true)
	})

	it("rethrows a failing job rather than swallowing it in the finally", async () => {
		await expect(
			inCarriedSpan("deliver", {}, {}, async () => {
				throw new Error("smtp refused")
			}),
		).rejects.toThrow("smtp refused")
	})

	it("leaves no span active once the job is done", async () => {
		await inCarriedSpan("deliver", {}, {}, async () => undefined)
		expect(activeTraceIds()).toBeUndefined()
	})

	it("keeps two attempts of one job in the same trace", async () => {
		const { carrier } = enqueued()

		const first = await inCarriedSpan("deliver", carrier, {}, async () => activeTraceIds())
		const second = await inCarriedSpan("deliver", carrier, {}, async () => activeTraceIds())

		expect(first?.trace_id).toBe(second?.trace_id)
		expect(first?.span_id).not.toBe(second?.span_id)
	})
})

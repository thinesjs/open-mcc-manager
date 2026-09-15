import { context, trace } from "@opentelemetry/api"
import { afterAll, describe, expect, it } from "vitest"
import { createLogger, type Field } from "./logger"
import {
	activeTraceIds,
	carrierForActiveContext,
	contextFromCarrier,
	hasTraceparent,
	startTracing,
	TRACEPARENT,
	tracesUrl,
} from "./tracing"

const parsed = (line: string | undefined): Record<string, Field> => JSON.parse(line ?? "{}")

describe("where the exporter is told to send spans", () => {
	it("appends the traces path to the base endpoint the cluster hands us", () => {
		expect(tracesUrl("http://alloy.monitoring.svc.cluster.local:4318")).toBe(
			"http://alloy.monitoring.svc.cluster.local:4318/v1/traces",
		)
	})

	it("does not double the slash when the endpoint has a trailing one", () => {
		expect(tracesUrl("http://alloy:4318/")).toBe("http://alloy:4318/v1/traces")
		expect(tracesUrl("  http://alloy:4318//  ")).toBe("http://alloy:4318/v1/traces")
	})

	it("strips any number of trailing slashes, not just one or two", () => {
		expect(tracesUrl(`http://alloy:4318${"/".repeat(40)}`)).toBe("http://alloy:4318/v1/traces")
	})
})

describe("tracing that has not been switched on", () => {
	it("stays dormant when no endpoint is configured, rather than exporting nowhere", async () => {
		for (const endpoint of [undefined, "", "   "]) {
			const handle = startTracing(
				endpoint === undefined ? { service: "test" } : { service: "test", endpoint },
			)
			await expect(handle.shutdown()).resolves.toBeUndefined()
		}
	})

	it("says so, so a caller can surface the gap rather than wondering", () => {
		expect(startTracing({ service: "test" }).active).toBe(false)
		expect(startTracing({ service: "test", endpoint: "  " }).active).toBe(false)
	})

	it("reports no trace ids when nothing is active", () => {
		expect(activeTraceIds()).toBeUndefined()
	})
})

describe("telemetry that cannot reach its collector", () => {
	it("shuts down without rejecting, so a dead collector cannot crash the service", async () => {
		const handle = startTracing({
			service: "unreachable",
			endpoint: "http://127.0.0.1:1",
		})
		const tracer = trace.getTracer("unreachable")
		tracer.startActiveSpan("doomed", (span) => span.end())

		await expect(handle.shutdown()).resolves.toBeUndefined()
	})
})

describe("the wiring that makes a log line find its trace", () => {
	const handle = startTracing({
		service: "open-mcc-test",
		version: "0.0.0-test",
		endpoint: "http://127.0.0.1:4318",
	})

	afterAll(async () => {
		await handle.shutdown()
	})

	it("reports itself active once an endpoint is configured", () => {
		expect(handle.active).toBe(true)
	})

	it("registers a global context manager, so an active span is discoverable", () => {
		const tracer = trace.getTracer("test")

		const seen = tracer.startActiveSpan("outer", (span) => {
			const ids = activeTraceIds()
			span.end()
			return ids
		})

		expect(seen).toBeDefined()
		expect(seen?.trace_id).toMatch(/^[0-9a-f]{32}$/)
		expect(seen?.span_id).toMatch(/^[0-9a-f]{16}$/)
	})

	it("puts those ids on a log line without the call site passing them", () => {
		const lines: string[] = []
		const log = createLogger({
			write: (line) => void lines.push(line),
			activeTrace: activeTraceIds,
		})
		const tracer = trace.getTracer("test")

		tracer.startActiveSpan("delivery", (span) => {
			log.info("attempting")
			span.end()
		})

		const line = parsed(lines[0])
		expect(String(line.trace_id)).toMatch(/^[0-9a-f]{32}$/)
		expect(String(line.span_id)).toMatch(/^[0-9a-f]{16}$/)
	})

	it("keeps a child span in its parent's trace", () => {
		const tracer = trace.getTracer("test")

		const ids = tracer.startActiveSpan("parent", (parent) => {
			const outer = activeTraceIds()
			const inner = tracer.startActiveSpan("child", (child) => {
				const found = activeTraceIds()
				child.end()
				return found
			})
			parent.end()
			return { outer, inner }
		})

		expect(ids.inner?.trace_id).toBe(ids.outer?.trace_id)
		expect(ids.inner?.span_id).not.toBe(ids.outer?.span_id)
	})

	it("stops reporting ids once the span has gone out of scope", () => {
		const tracer = trace.getTracer("test")
		tracer.startActiveSpan("brief", (span) => span.end())
		expect(activeTraceIds()).toBeUndefined()
	})
})

describe("carrying trace context through a queue", () => {
	const handle = startTracing({ service: "hop", endpoint: "http://127.0.0.1:4318" })

	afterAll(async () => {
		await handle.shutdown()
	})

	it("writes a traceparent when a span is active", () => {
		const tracer = trace.getTracer("hop")
		const carrier = tracer.startActiveSpan("enqueue", (span) => {
			const written = carrierForActiveContext()
			span.end()
			return written
		})

		expect(hasTraceparent(carrier)).toBe(true)
		expect(carrier[TRACEPARENT]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
	})

	it("writes nothing when no span is active, so a job carries no empty context", () => {
		const carrier = carrierForActiveContext()
		expect(hasTraceparent(carrier)).toBe(false)
	})

	it("hands back a context whose span belongs to the trace that enqueued it", () => {
		const tracer = trace.getTracer("hop")

		const enqueued = tracer.startActiveSpan("enqueue", (span) => {
			const ids = activeTraceIds()
			const written = carrierForActiveContext()
			span.end()
			return { ids, written }
		})

		const parent = contextFromCarrier(enqueued.written)
		const delivered = context.with(parent, () =>
			tracer.startActiveSpan("deliver", (span) => {
				const ids = activeTraceIds()
				span.end()
				return ids
			}),
		)

		expect(delivered?.trace_id).toBe(enqueued.ids?.trace_id)
		expect(delivered?.span_id).not.toBe(enqueued.ids?.span_id)
	})

	it("keeps a second attempt in the same trace, which is what a retry needs", () => {
		const tracer = trace.getTracer("hop")

		const carrier = tracer.startActiveSpan("enqueue", (span) => {
			const written = carrierForActiveContext()
			span.end()
			return written
		})
		const parent = contextFromCarrier(carrier)

		const attempts = [1, 2].map((attempt) =>
			context.with(parent, () =>
				tracer.startActiveSpan(`attempt ${attempt}`, (span) => {
					const ids = activeTraceIds()
					span.end()
					return ids
				}),
			),
		)

		expect(attempts[0]?.trace_id).toBe(attempts[1]?.trace_id)
		expect(attempts[0]?.span_id).not.toBe(attempts[1]?.span_id)
	})

	it("treats a malformed traceparent as no context rather than throwing", () => {
		for (const bad of ["", "nonsense", "00-tooshort-x-01"]) {
			const derived = contextFromCarrier({ [TRACEPARENT]: bad })
			expect(trace.getSpan(derived)).toBeUndefined()
		}
	})
})

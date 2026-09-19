import { isSpanContextValid, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-node"
import {
	InMemorySpanExporter,
	NodeTracerProvider,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node"
import { Hono } from "hono"
import { afterAll, describe, expect, it } from "vitest"
import { requestSpan } from "./request-span"

const exporter = new InMemorySpanExporter()

const atStart: { name: string; attributes: Record<string, string> }[] = []

const captureOnStart: SpanProcessor = {
	onStart: (span: Span) =>
		void atStart.push({
			name: span.name,
			attributes: Object.fromEntries(
				Object.entries(span.attributes).map(([key, value]) => [key, String(value)]),
			),
		}),
	onEnd: (_span: ReadableSpan) => undefined,
	forceFlush: async () => undefined,
	shutdown: async () => undefined,
}

const provider = new NodeTracerProvider({
	spanProcessors: [captureOnStart, new SimpleSpanProcessor(exporter)],
})
provider.register()

const traced = () => {
	const seen: string[] = []
	const app = new Hono()
	app.use("*", requestSpan())
	app.get("/healthz", (c) => c.json({ ok: true }))
	app.get("/api/avatars/:username", (c) => {
		seen.push(activeSpanId())
		return c.json({ ok: true })
	})
	app.post("/trpc/:proc", (c) => {
		seen.push(activeSpanId())
		return c.json({ ok: true }, 201)
	})
	app.get("/boom", () => {
		throw new Error("handler exploded")
	})
	app.all("/anything", (c) => c.json({ ok: true }))
	return { app, seen }
}

const spans = () => exporter.getFinishedSpans()

const activeSpanId = (): string => {
	const span = trace.getActiveSpan()
	if (!span) return ""
	const ctx = span.spanContext()
	return isSpanContextValid(ctx) ? ctx.spanId : ""
}

describe("the request span that makes trace propagation possible at all", () => {
	afterAll(async () => {
		await provider.shutdown()
	})

	it("makes a span active inside the handler, which is what the queue hop needs", async () => {
		exporter.reset()
		const { app, seen } = traced()

		const res = await app.request("/api/avatars/steve")
		const span = spans().at(-1)

		expect(res.status).toBe(200)
		expect(seen[0]).toMatch(/^[0-9a-f]{16}$/)
		expect(seen[0]).toBe(span?.spanContext().spanId)
	})

	it("records the route pattern, not the concrete path, so no username reaches a trace", async () => {
		exporter.reset()
		const { app } = traced()

		await app.request("/api/avatars/steve")
		const span = spans().at(-1)

		expect(span?.attributes["http.route"]).toBe("/api/avatars/:username")
		expect(span?.name).toBe("GET /api/avatars/:username")
		for (const value of Object.values(span?.attributes ?? {})) {
			expect(String(value)).not.toContain("steve")
		}
		expect(span?.name).not.toContain("steve")
	})

	it("is a server span carrying the method and the real status code", async () => {
		exporter.reset()
		const { app } = traced()

		await app.request("/trpc/notification.test", { method: "POST" })
		const span = spans().at(-1)

		expect(span?.kind).toBe(SpanKind.SERVER)
		expect(span?.attributes["http.request.method"]).toBe("POST")
		expect(span?.attributes["http.response.status_code"]).toBe(201)
		expect(span?.attributes["http.route"]).toBe("/trpc/:proc")
	})

	it("never lets a concrete path reach a span at onStart, in its name or its attributes", async () => {
		exporter.reset()
		atStart.length = 0
		const { app } = traced()

		await app.request("/api/avatars/steve")

		expect(atStart).toHaveLength(1)
		expect(atStart[0]?.name).toBe("GET")
		for (const started of atStart) {
			expect(started.name).not.toContain("steve")
			for (const value of Object.values(started.attributes)) {
				expect(value).not.toContain("steve")
			}
		}
	})

	it("folds an unknown method into _OTHER, keeping the original off the span name", async () => {
		exporter.reset()
		atStart.length = 0
		const { app } = traced()

		await app.request("/anything", { method: "PURGE" })
		const span = spans().at(-1)

		expect(span?.name).toBe("_OTHER /anything")
		expect(atStart[0]?.name).toBe("_OTHER")
		expect(span?.attributes["http.request.method"]).toBe("_OTHER")
		expect(span?.attributes["http.request.method_original"]).toBe("PURGE")
	})

	it("leaves a known method alone, and reports no original for it", async () => {
		exporter.reset()
		const { app } = traced()

		await app.request("/anything", { method: "DELETE" })
		const span = spans().at(-1)

		expect(span?.name).toBe("DELETE /anything")
		expect(span?.attributes["http.request.method"]).toBe("DELETE")
		expect(span?.attributes["http.request.method_original"]).toBeUndefined()
	})

	it("omits the route entirely on a 404, rather than reporting the wildcard", async () => {
		exporter.reset()
		const { app } = traced()

		const res = await app.request("/nothing/here")
		const span = spans().at(-1)

		expect(res.status).toBe(404)
		expect(span?.attributes["http.route"]).toBeUndefined()
		expect(span?.name).toBe("GET")
	})

	it("marks a 5xx as an error even though hono swallows the throw", async () => {
		exporter.reset()
		const { app } = traced()

		const res = await app.request("/boom")
		const span = spans().at(-1)

		expect(res.status).toBe(500)
		expect(span?.status.code).toBe(SpanStatusCode.ERROR)
	})

	it("leaves the readiness probe unspanned, so it cannot drown the trace stream", async () => {
		exporter.reset()
		const { app } = traced()

		const res = await app.request("/healthz")

		expect(res.status).toBe(200)
		expect(spans()).toHaveLength(0)
	})
})

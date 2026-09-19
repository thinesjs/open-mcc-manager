import { createDb } from "@open-mcc/db"
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import {
	InMemorySpanExporter,
	NodeTracerProvider,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node"
import { ATTR_DB_OPERATION_NAME, ATTR_DB_SYSTEM_NAME } from "@opentelemetry/semantic-conventions"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { tracedDialect } from "./query-span"

const url = process.env.TEST_DATABASE_URL ?? ""

const DB_SPAN = "db.query"

describe("the attributes a db span actually carries", () => {
	const exporter = new InMemorySpanExporter()
	const provider = new NodeTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	})
	provider.register()
	const db = createDb(url, tracedDialect)

	afterAll(async () => {
		await db.destroy()
		await provider.shutdown()
	})

	const spanFor = async (run: () => Promise<void>) => {
		exporter.reset()
		await run()
		return exporter.getFinishedSpans().find((each) => each.name === DB_SPAN)
	}

	const spanForOneQuery = async () =>
		await spanFor(async () => {
			await sql<{ answer: number }>`select 1 as answer`.execute(db)
		})

	it("names the database system with semconv's stable key", async () => {
		const span = await spanForOneQuery()

		expect(span).toBeDefined()
		expect(span?.attributes[ATTR_DB_SYSTEM_NAME]).toBe("postgresql")
	})

	it("reports a builder select as Select and a raw query as Raw, not one label for both", async () => {
		const built = await spanFor(async () => {
			await db.selectFrom("organization").select("id").limit(1).execute()
		})
		const raw = await spanForOneQuery()

		expect(built?.attributes[ATTR_DB_OPERATION_NAME]).toBe("Select")
		expect(raw?.attributes[ATTR_DB_OPERATION_NAME]).toBe("Raw")
	})

	it("uses the stable attribute names, not the older experimental ones", async () => {
		const span = await spanForOneQuery()

		expect(ATTR_DB_OPERATION_NAME).toBe("db.operation.name")
		expect(ATTR_DB_SYSTEM_NAME).toBe("db.system.name")
		expect("db.operation" in (span?.attributes ?? {})).toBe(false)
	})

	it("carries exactly two attributes and nothing else, so nothing can leak by addition", async () => {
		const span = await spanForOneQuery()

		expect(Object.keys(span?.attributes ?? {}).sort()).toEqual(
			[ATTR_DB_OPERATION_NAME, ATTR_DB_SYSTEM_NAME].sort(),
		)
		expect(span?.name).toBe(DB_SPAN)
	})

	it("carries no sql text, connection string or address in any attribute", async () => {
		const span = await spanForOneQuery()

		for (const value of Object.values(span?.attributes ?? {})) {
			const text = String(value)
			expect(text.toLowerCase()).not.toContain("select 1")
			expect(text).not.toContain("postgres://")
			expect(text).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/)
		}
	})

	it("hangs the query off the caller's span rather than starting a trace of its own", async () => {
		const tracer = trace.getTracer("caller")
		const outer = await new Promise<{ traceId: string; spanId: string }>((resolve) => {
			void tracer.startActiveSpan("request", async (span) => {
				const ctx = span.spanContext()
				exporter.reset()
				await sql<{ answer: number }>`select 1 as answer`.execute(db)
				span.end()
				resolve({ traceId: ctx.traceId, spanId: ctx.spanId })
			})
		})

		const span = exporter.getFinishedSpans().find((each) => each.name === DB_SPAN)

		expect(span?.spanContext().traceId).toBe(outer.traceId)
		expect(span?.parentSpanContext?.spanId).toBe(outer.spanId)
	})

	it("is a client span, so a backend can draw the edge to postgres", async () => {
		const span = await spanForOneQuery()
		expect(span?.kind).toBe(SpanKind.CLIENT)
	})

	it("marks a failed query's span as an error rather than leaving it ok", async () => {
		exporter.reset()
		await expect(sql`select * from a_table_that_is_not_there`.execute(db)).rejects.toThrow()

		const span = exporter.getFinishedSpans().find((each) => each.name === DB_SPAN)
		expect(span?.status.code).toBe(SpanStatusCode.ERROR)
	})
})

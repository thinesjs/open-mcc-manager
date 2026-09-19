import { trace } from "@opentelemetry/api"
import {
	InMemorySpanExporter,
	NodeTracerProvider,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
})
provider.register()

const lines: string[] = []
let restore: (() => void) | undefined

const loadRoot = async (level: string | undefined) => {
	vi.resetModules()
	if (level === undefined) vi.stubEnv("LOG_LEVEL", "")
	else vi.stubEnv("LOG_LEVEL", level)
	const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		lines.push(String(chunk))
		return true
	})
	restore = () => spy.mockRestore()
	return await import("./root-logger")
}

beforeEach(() => {
	lines.length = 0
})

afterEach(() => {
	restore?.()
	vi.unstubAllEnvs()
})

afterAll(async () => {
	await provider.shutdown()
})

describe("the root logger this daemon actually constructs at startup", () => {
	it("names itself open-mcc-worker on every line, so the two daemons cannot be confused", async () => {
		const { rootLogger, SERVICE } = await loadRoot("info")

		rootLogger.info("a line")

		expect(SERVICE).toBe("open-mcc-worker")
		expect(JSON.parse(lines[0] ?? "{}").service).toBe("open-mcc-worker")
	})

	it("honours LOG_LEVEL=warn by dropping an info line it would otherwise emit", async () => {
		const { rootLogger } = await loadRoot("warn")

		rootLogger.info("a line that must not appear")

		expect(lines).toEqual([])
	})

	it("honours LOG_LEVEL=warn by still emitting a warn line", async () => {
		const { rootLogger } = await loadRoot("warn")

		rootLogger.warn("a line that must appear")

		expect(JSON.parse(lines[0] ?? "{}").level).toBe("warn")
	})

	it("stamps the active trace ids, so a line can be followed across processes", async () => {
		const { rootLogger } = await loadRoot("info")

		await trace.getTracer("test").startActiveSpan("a span", async (span) => {
			rootLogger.info("inside a span")
			span.end()
		})

		const entry = JSON.parse(lines[0] ?? "{}")
		expect(entry.trace_id).toMatch(/^[0-9a-f]{32}$/)
		expect(entry.span_id).toMatch(/^[0-9a-f]{16}$/)
	})
})

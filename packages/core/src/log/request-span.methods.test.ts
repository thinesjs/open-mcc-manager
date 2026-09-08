import {
	InMemorySpanExporter,
	NodeTracerProvider,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node"
import { afterAll, describe, expect, it } from "vitest"

process.env.OTEL_INSTRUMENTATION_HTTP_KNOWN_METHODS = "PURGE, GET"

const { inRequestSpan, knownMethods } = await import("./request-span")

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
provider.register()

const spanFor = async (method: string) => {
	exporter.reset()
	await inRequestSpan(method, async () => ({ route: "/x", status: 200 }))
	return exporter.getFinishedSpans().at(-1)
}

describe("which HTTP methods this instrumentation treats as known", () => {
	afterAll(async () => {
		await provider.shutdown()
	})

	it("takes the standard override from the environment, replacing the defaults outright", async () => {
		const purge = await spanFor("PURGE")
		const post = await spanFor("POST")

		expect(purge?.name, "the override never reached the span").toBe("PURGE /x")
		expect(post?.name, "the override must replace the defaults, not extend them").toBe("_OTHER /x")
		expect(post?.attributes["http.request.method_original"]).toBe("POST")
	})

	it("keeps a method the override does list, without recording an original for it", async () => {
		const get = await spanFor("GET")

		expect(get?.name).toBe("GET /x")
		expect(get?.attributes["http.request.method_original"]).toBeUndefined()
	})

	it("counts QUERY among the defaults, and is case-sensitive", () => {
		expect(knownMethods(undefined)).toContain("QUERY")
		expect(knownMethods(undefined)).not.toContain("query")
		expect(knownMethods("  PURGE , ,PROPFIND ")).toEqual(["PURGE", "PROPFIND"])
		expect(knownMethods("   ")).toContain("GET")
	})
})

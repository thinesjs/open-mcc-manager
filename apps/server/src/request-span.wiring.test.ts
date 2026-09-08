import { generateKeyPair } from "@open-mcc/core"
import { SpanStatusCode } from "@opentelemetry/api"
import {
	InMemorySpanExporter,
	NodeTracerProvider,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type ServerHandle, startServer } from "./bootstrap"
import type { Env } from "./env"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
provider.register()

let handle: ServerHandle | undefined

const env = async (): Promise<Env> => ({
	DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
	PORT: 0,
	STATUS_RETENTION_DAYS: 30,
	BETTER_AUTH_SECRET: "a-very-long-test-secret-value-000000",
	BETTER_AUTH_URL: "http://localhost:3000",
	SEALBOX_KEYS: await generateKeyPair("k1"),
	ALLOWED_ORIGINS: "http://localhost:5173",
	NOTIFICATION_ALLOW_HTTP: false,
	NOTIFICATION_ALLOWED_HOSTS: "",
	NOTIFICATION_ALLOWED_ADDRESSES: "",
	NOTIFICATION_TEAMS_HOSTS: "",
	LOG_LEVEL: "info",
	OTEL_EXPORTER_OTLP_ENDPOINT: "",
})

afterEach(async () => {
	if (handle) {
		handle.scheduler.stop()
		handle.healthPoller.stop()
		handle.heartbeat.stop()
		await handle.boss.stop({ graceful: false })
		await handle.lock.release()
		await handle.db.destroy()
		handle = undefined
	}
	await provider.forceFlush()
})

describe("the request span is wired into the app the server actually builds", () => {
	it("spans a request driven through the real app, not a test-assembled one", async () => {
		handle = await startServer(await env(), vi.fn())
		exporter.reset()

		const res = await handle.app.request("/api/avatars/steve")
		const span = exporter.getFinishedSpans().find((each) => each.name.startsWith("GET"))

		expect(res.status).toBeGreaterThan(0)
		expect(
			span,
			"no span was produced by the real app — is the middleware still wired?",
		).toBeDefined()
		expect(span?.attributes["http.route"]).toBe("/api/avatars/:username")
		for (const value of Object.values(span?.attributes ?? {})) {
			expect(String(value)).not.toContain("steve")
		}
	})

	it("opens a child span per resolved trpc procedure, nested in the http span", async () => {
		handle = await startServer(await env(), vi.fn())
		exporter.reset()

		const res = await handle.app.request("/trpc/sshKey.list?input=%7B%7D", {
			headers: { origin: "http://localhost:5173" },
		})

		const finished = exporter.getFinishedSpans()
		const procedure = finished.find((each) => each.name === "query sshKey.list")
		const parent = finished.find(
			(each) => each.spanContext().spanId === procedure?.parentSpanContext?.spanId,
		)

		expect(
			procedure,
			"no per-procedure span — is the trpc middleware still on the base?",
		).toBeDefined()
		expect(procedure?.attributes["rpc.method"]).toBe("sshKey.list")
		expect(procedure?.attributes["rpc.system"]).toBe("trpc")
		expect(parent, "the procedure span has no parent in this trace").toBeDefined()
		expect(parent?.attributes["http.route"]).toBe("/trpc/*")
		expect(procedure?.spanContext().traceId).toBe(parent?.spanContext().traceId)
		expect(res.status).toBe(401)
		expect(
			procedure?.status.code,
			"trpc resolves rather than throws on a refusal, so the span must read the result",
		).toBe(SpanStatusCode.ERROR)
	})

	it("spans a public procedure too, which no protected-only wiring would reach", async () => {
		handle = await startServer(await env(), vi.fn())
		exporter.reset()

		const res = await handle.app.request("/trpc/member.acceptInvitation", {
			method: "POST",
			headers: { origin: "http://localhost:5173", "content-type": "application/json" },
			body: JSON.stringify({
				invitationId: `missing-${Math.random().toString(36).slice(2, 10)}`,
				password: "a-long-enough-password",
				name: "Somebody",
			}),
		})
		const procedure = exporter
			.getFinishedSpans()
			.find((each) => each.name === "mutation member.acceptInvitation")

		expect(res.status).toBe(400)
		expect(await res.text()).toContain("INVITATION_NOT_FOUND")
		expect(
			procedure,
			"no span for a public procedure — is publicProcedure still built on the traced base?",
		).toBeDefined()
		expect(procedure?.status.code).toBe(SpanStatusCode.ERROR)
	})

	it("still leaves the real app's readiness probe unspanned", async () => {
		handle = await startServer(await env(), vi.fn())
		exporter.reset()

		const res = await handle.app.request("/healthz")

		expect(res.status).toBe(200)
		expect(exporter.getFinishedSpans().filter((s) => s.name.startsWith("GET"))).toHaveLength(0)
	})
})

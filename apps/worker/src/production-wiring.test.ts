import { createLogger, generateKeyPair, type Logger } from "@open-mcc/core"
import { PgBoss } from "pg-boss"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WorkerEnv } from "./env"

vi.mock("@open-mcc/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@open-mcc/core")>()
	return { ...actual, createCleanupHandler: () => async () => 4 }
})

const capturing = (): { lines: string[]; logger: Logger } => {
	const lines: string[] = []
	return { lines, logger: createLogger({ level: "debug", write: (line) => lines.push(line) }) }
}

const env = async (): Promise<WorkerEnv> => ({
	DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
	SEALBOX_KEYS: await generateKeyPair("k1"),
	STATUS_RETENTION_DAYS: 30,
	NOTIFICATION_ALLOW_HTTP: false,
	NOTIFICATION_ALLOWED_HOSTS: "",
	NOTIFICATION_ALLOWED_ADDRESSES: "",
	OTEL_EXPORTER_OTLP_ENDPOINT: "",
})

let stop: (() => Promise<void>) | undefined

afterEach(async () => {
	if (stop) await stop()
	stop = undefined
	vi.restoreAllMocks()
})

describe("the cleanup handler the worker actually registers", () => {
	it("reports the swept count, so a sweep that removed rows cannot pass silently", async () => {
		const workSpy = vi.spyOn(PgBoss.prototype, "work")
		const { startWorker } = await import("./bootstrap")
		const { lines, logger } = capturing()

		const handle = await startWorker(await env(), logger)
		stop = async () => await handle.stop()

		const cleanup = workSpy.mock.calls.find(([queue]) => String(queue).includes("cleanup"))
		const handler = cleanup?.[cleanup.length - 1]
		expect(typeof handler).toBe("function")

		lines.length = 0
		if (typeof handler === "function") await handler([])

		const entry = JSON.parse(lines[0] ?? "{}")
		expect(entry.level).toBe("info")
		expect(entry.message).toBe("Removed 4 notifications past retention")
	})
})

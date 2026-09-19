import { createLogger, generateKeyPair } from "@open-mcc/core"
import { PgBoss } from "pg-boss"
import { afterEach, describe, expect, it, vi } from "vitest"
import { startWorker, type WorkerHandle } from "./bootstrap"
import type { WorkerEnv } from "./env"

const capturing = () => {
	const lines: string[] = []
	return { lines, logger: createLogger({ level: "debug", write: (line) => lines.push(line) }) }
}

let handle: WorkerHandle | undefined

const env = async (): Promise<WorkerEnv> => ({
	DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
	SEALBOX_KEYS: await generateKeyPair("k1"),
	STATUS_RETENTION_DAYS: 30,
	NOTIFICATION_ALLOW_HTTP: false,
	NOTIFICATION_ALLOWED_HOSTS: "",
	NOTIFICATION_ALLOWED_ADDRESSES: "",
	OTEL_EXPORTER_OTLP_ENDPOINT: "",
})

afterEach(async () => {
	if (handle) {
		await handle.stop()
		handle = undefined
	}
})

describe("the worker the daemon actually builds logs through its root logger", () => {
	it("attaches exactly one queue warning listener, and it is the shared adapter", async () => {
		const { lines, logger } = capturing()
		handle = await startWorker(await env(), logger)

		const attached = handle.boss.listeners("warning")
		expect(attached).toHaveLength(1)

		lines.length = 0
		attached[0]?.({ message: "a queue warning", data: { secret: "must-not-appear" } })

		const written = lines.join("")
		expect(JSON.parse(written).message).toBe("a queue warning")
		expect(JSON.parse(written).level).toBe("warn")
		expect(written).not.toContain("must-not-appear")
		expect(written).not.toContain("secret")
	})
	it("registers the warning listener BEFORE the queue starts, because warnings fire during start", async () => {
		const onSpy = vi.spyOn(PgBoss.prototype, "on")
		const startSpy = vi.spyOn(PgBoss.prototype, "start")

		handle = await startWorker(await env(), capturing().logger)

		const warningCall = onSpy.mock.calls.findIndex((call) => call[0] === "warning")
		expect(warningCall).toBeGreaterThanOrEqual(0)
		expect(onSpy.mock.invocationCallOrder[warningCall]).toBeLessThan(
			startSpy.mock.invocationCallOrder[0] ?? 0,
		)

		onSpy.mockRestore()
		startSpy.mockRestore()
	})

	it("logs a job queue error at error, through the logger rather than the console", async () => {
		const { lines, logger } = capturing()
		handle = await startWorker(await env(), logger)

		lines.length = 0
		handle.boss.emit("error", new Error("the queue broke"))

		const entry = JSON.parse(lines[0] ?? "{}")
		expect(entry.level).toBe("error")
		expect(entry.message).toBe("Job queue error")
		expect(entry.detail).toBe("the queue broke")
	})

	it("registers a cleanup handler that runs the retention sweep through its reporter", async () => {
		const workSpy = vi.spyOn(PgBoss.prototype, "work")

		handle = await startWorker(await env(), capturing().logger)

		const cleanup = workSpy.mock.calls.find(([queue]) => String(queue).includes("cleanup"))
		expect(cleanup).toBeDefined()

		const handler = cleanup?.[cleanup.length - 1]
		expect(typeof handler).toBe("function")
		if (typeof handler === "function") await handler([])

		workSpy.mockRestore()
	})
})

import { createLogger, generateKeyPair, KNOWN_INSECURE_KEY_ID, type Level } from "@open-mcc/core"
import { PgBoss } from "pg-boss"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type ServerHandle, startServer } from "./bootstrap"
import type { Env } from "./env"

type Captured = { readonly lines: string[]; readonly logger: ReturnType<typeof createLogger> }

const capturing = (level: Level): Captured => {
	const lines: string[] = []
	return { lines, logger: createLogger({ level, write: (line) => lines.push(line) }) }
}

const entries = (lines: readonly string[]) => lines.map((line) => JSON.parse(line))

let handle: ServerHandle | undefined

const env = async (keys?: string): Promise<Env> => ({
	DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
	PORT: 0,
	STATUS_RETENTION_DAYS: 30,
	BETTER_AUTH_SECRET: "a-very-long-test-secret-value-000000",
	BETTER_AUTH_URL: "http://localhost:3000",
	SEALBOX_KEYS: keys ?? (await generateKeyPair("k1")),
	ALLOWED_ORIGINS: "http://localhost:5173",
	NOTIFICATION_ALLOW_HTTP: false,
	NOTIFICATION_ALLOWED_HOSTS: "",
	NOTIFICATION_ALLOWED_ADDRESSES: "",
	NOTIFICATION_TEAMS_HOSTS: "",
	OTEL_EXPORTER_OTLP_ENDPOINT: "",
})

const devKeys = async (): Promise<string> => {
	const real = await generateKeyPair("k1")
	const parts = real.split(":")
	return `${KNOWN_INSECURE_KEY_ID}:${parts.slice(1).join(":")}`
}

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
})

describe("the server the daemon actually builds logs through its root logger", () => {
	it("attaches exactly one queue warning listener, and it logs the message without the payload", async () => {
		const { lines, logger } = capturing("info")
		handle = await startServer(await env(), vi.fn(), logger)

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

		handle = await startServer(await env(), vi.fn(), capturing("info").logger)

		const warningCall = onSpy.mock.calls.findIndex((call) => call[0] === "warning")
		expect(warningCall).toBeGreaterThanOrEqual(0)
		expect(onSpy.mock.invocationCallOrder[warningCall]).toBeLessThan(
			startSpy.mock.invocationCallOrder[0] ?? 0,
		)

		onSpy.mockRestore()
		startSpy.mockRestore()
	})

	it("warns about the publicly known development key through the logger, not the console", async () => {
		const { lines, logger } = capturing("warn")
		handle = await startServer(await env(await devKeys()), vi.fn(), logger)

		const warning = entries(lines).find((entry) => String(entry.message).includes("SEALBOX_KEYS"))
		expect(warning?.level).toBe("warn")
	})

	it("drops that same warning when the configured level is error, so the level is honoured", async () => {
		const { lines, logger } = capturing("error")
		handle = await startServer(await env(await devKeys()), vi.fn(), logger)

		expect(
			entries(lines).filter((entry) => String(entry.message).includes("SEALBOX_KEYS")),
		).toEqual([])
	})

	it("logs a job queue error at error, through the logger rather than the console", async () => {
		const { lines, logger } = capturing("info")
		handle = await startServer(await env(), vi.fn(), logger)

		lines.length = 0
		handle.boss.emit("error", new Error("the queue broke"))

		const entry = JSON.parse(lines[0] ?? "{}")
		expect(entry.level).toBe("error")
		expect(entry.message).toBe("Job queue error")
		expect(entry.detail).toBe("the queue broke")
	})
})

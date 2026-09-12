import { createLogger, generateKeyPair, INSTANCE_ARTIFACT_QUEUE, type Logger } from "@open-mcc/core"
import { PgBoss } from "pg-boss"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WorkerEnv } from "./env"

vi.mock("@open-mcc/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@open-mcc/core")>()
	return {
		...actual,
		createArtifactCollector: () => async () => ({
			hosts: 1,
			unreachable: 0,
			collected: 7,
			oversize: 0,
			refused: 0,
			failed: 0,
			replaysPruned: 2,
			cacheDirectoriesPruned: 1,
			storedPruned: 0,
			mailerStateOverBudget: 3,
		}),
	}
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

describe("the artifact collection the worker actually registers", () => {
	it("runs it on a schedule and reports what it collected and what it could not", async () => {
		const workSpy = vi.spyOn(PgBoss.prototype, "work")
		const scheduleSpy = vi.spyOn(PgBoss.prototype, "schedule")
		const { startWorker } = await import("./bootstrap")
		const { lines, logger } = capturing()

		const handle = await startWorker(await env(), logger)
		stop = async () => await handle.stop()

		expect(scheduleSpy.mock.calls.some(([queue]) => queue === INSTANCE_ARTIFACT_QUEUE)).toBe(true)

		const registered = workSpy.mock.calls.find(([queue]) => queue === INSTANCE_ARTIFACT_QUEUE)
		const handler = registered?.[registered.length - 1]
		expect(typeof handler).toBe("function")

		lines.length = 0
		if (typeof handler === "function") await handler([])

		const messages = lines.map((line) => String(JSON.parse(line).message))
		expect(messages.some((message) => message.includes("Collected 7 instance artifacts"))).toBe(
			true,
		)
		expect(messages.some((message) => message.includes("Mailer state"))).toBe(true)
	})
})

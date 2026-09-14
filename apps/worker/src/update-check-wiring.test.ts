import {
	createLogger,
	generateKeyPair,
	type Logger,
	SYSTEM_UPDATE_CHECK_QUEUE,
} from "@open-mcc/core"
import type { UpdateStateRow } from "@open-mcc/db"
import { PgBoss } from "pg-boss"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WorkerEnv } from "./env"

const state = vi.hoisted(() => {
	const shared: { lastCheckedAt: Date | undefined; checks: number } = {
		lastCheckedAt: undefined,
		checks: 0,
	}
	return shared
})

vi.mock("@open-mcc/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@open-mcc/core")>()
	return {
		...actual,
		createUpdateStateRepository: () => ({
			find: async () =>
				state.lastCheckedAt === undefined ? undefined : rowCheckedAt(state.lastCheckedAt),
			recordCheck: async () => undefined,
		}),
		createUpdateCheck: () => async () => {
			state.checks += 1
			return { checked: true, outcome: "rate-limited" }
		},
	}
})

const rowCheckedAt = (checkedAt: Date): UpdateStateRow => ({
	id: "singleton",
	sourceOwner: "thinesjs",
	sourceRepo: "open-mcc-manager",
	checkedAt,
	checkOutcome: "ok",
	rateLimitedUntil: null,
	latestVersion: "1.4.0",
	latestNotes: null,
	notesTruncated: false,
})

const HOUR_MS = 60 * 60 * 1000

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

const asReleaseBuild = () => {
	vi.stubEnv("APP_VERSION", "1.4.0")
	vi.stubEnv("GIT_SHA", "abc123def456")
}

let stop: (() => Promise<void>) | undefined

afterEach(async () => {
	if (stop) await stop()
	stop = undefined
	state.lastCheckedAt = undefined
	state.checks = 0
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

const start = async (logger: Logger = capturing().logger) => {
	const workSpy = vi.spyOn(PgBoss.prototype, "work")
	const scheduleSpy = vi.spyOn(PgBoss.prototype, "schedule")
	const sendSpy = vi.spyOn(PgBoss.prototype, "send").mockImplementation(async () => null)
	const { startWorker } = await import("./bootstrap")
	const handle = await startWorker(await env(), logger)
	stop = async () => await handle.stop()
	const bootSends = () =>
		sendSpy.mock.calls.filter(([queue]) => queue === SYSTEM_UPDATE_CHECK_QUEUE).length
	return { workSpy, scheduleSpy, bootSends }
}

describe("the release check the worker actually registers", () => {
	it("polls four times a day, at a minute no other schedule the worker registers uses", async () => {
		asReleaseBuild()
		state.lastCheckedAt = new Date(Date.now() - HOUR_MS)
		const { scheduleSpy } = await start()

		expect(
			scheduleSpy.mock.calls.some(
				([queue, cron]) => queue === SYSTEM_UPDATE_CHECK_QUEUE && cron === "41 */6 * * *",
			),
		).toBe(true)
		const minutes = scheduleSpy.mock.calls.map(([, cron]) => cron.split(" ")[0])
		expect(new Set(minutes).size).toBe(minutes.length)
	})

	it("runs the check it scheduled and warns when the check failed", async () => {
		asReleaseBuild()
		state.lastCheckedAt = new Date(Date.now() - HOUR_MS)
		const { lines, logger } = capturing()
		const { workSpy } = await start(logger)

		const registered = workSpy.mock.calls.find(([queue]) => queue === SYSTEM_UPDATE_CHECK_QUEUE)
		const handler = registered?.[registered.length - 1]
		expect(typeof handler).toBe("function")

		lines.length = 0
		if (typeof handler === "function") await handler([])

		expect(state.checks).toBe(1)
		const messages = lines.map((line) => String(JSON.parse(line).message))
		expect(messages).toContain("The release check failed: rate-limited")
	})

	it("checks at boot when the last check is older than the poll", async () => {
		asReleaseBuild()
		state.lastCheckedAt = new Date(Date.now() - 7 * HOUR_MS)
		const { bootSends } = await start()

		expect(bootSends()).toBe(1)
	})

	it("sends nothing at boot when the last check is recent, so a restart loop cannot hammer GitHub", async () => {
		asReleaseBuild()
		state.lastCheckedAt = new Date(Date.now() - HOUR_MS)
		const { bootSends } = await start()

		expect(bootSends()).toBe(0)
	})

	it("sends nothing at boot from a development build, even with nothing ever checked", async () => {
		state.lastCheckedAt = undefined
		const { bootSends } = await start()

		expect(bootSends()).toBe(0)
	})
})

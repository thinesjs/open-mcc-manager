import { createLogger } from "@open-mcc/core"
import { beforeEach, describe, expect, it, vi } from "vitest"

const sentinel = createLogger({ service: "sentinel-root", write: () => undefined })

vi.mock("./root-logger", () => ({ rootLogger: sentinel, SERVICE: "open-mcc-worker" }))

const startWorker = vi.fn(async () => ({ stop: async () => undefined }))

vi.mock("./bootstrap", () => ({ startWorker }))

beforeEach(() => {
	startWorker.mockClear()
	vi.stubEnv("LOG_LEVEL", "warn")
	vi.stubEnv("PORT", "1")
	vi.stubEnv("DATABASE_URL", "postgres://nobody:nobody@127.0.0.1:1/nope")
	vi.stubEnv("SEALBOX_KEYS", "k1:aaa:bbb")
	vi.stubEnv("BETTER_AUTH_SECRET", "a-very-long-test-secret-value-000000")
	vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000")
	vi.stubEnv("ALLOWED_ORIGINS", "http://localhost:5173")
	vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
})

describe("the logger this entrypoint hands to the bootstrap it starts", () => {
	it("is the root itself, not a separately constructed one", async () => {
		vi.resetModules()
		await import("./index")
		await vi.waitFor(() => expect(startWorker).toHaveBeenCalled())

		const handed = startWorker.mock.calls[0]?.at(-1)
		expect(handed).toBe(sentinel)
	})
})

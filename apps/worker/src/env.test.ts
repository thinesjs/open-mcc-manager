import { describe, expect, it } from "vitest"
import { loadWorkerEnv } from "./env"

const base = {
	DATABASE_URL: "postgres://localhost/open_mcc",
	SEALBOX_KEYS: "k1:secret",
}

describe("what the worker needs to start", () => {
	it("needs the database and the sealing keys, and nothing web-facing", () => {
		const env = loadWorkerEnv(base)

		expect(env.DATABASE_URL).toBe("postgres://localhost/open_mcc")
		expect(env.SEALBOX_KEYS).toBe("k1:secret")
	})

	it("refuses to start without a database rather than idling silently", () => {
		expect(() => loadWorkerEnv({ SEALBOX_KEYS: "k1:secret" })).toThrow()
	})

	it("refuses to start without the keys it needs to open host credentials", () => {
		expect(() => loadWorkerEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow()
	})

	it("polls on a sane interval by default", () => {
		expect(loadWorkerEnv(base).JOB_TICK_MS).toBe(10_000)
	})

	it("refuses an interval so short it would hammer the database", () => {
		expect(() => loadWorkerEnv({ ...base, JOB_TICK_MS: "10" })).toThrow()
	})
})

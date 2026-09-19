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

	it("ignores anything else the environment carries", () => {
		expect(loadWorkerEnv({ ...base, PORT: "3000" }).DATABASE_URL).toBe(base.DATABASE_URL)
	})
})

describe("where the worker is allowed to send a notification", () => {
	it("checks addresses and stays off the local network unless told otherwise", () => {
		const env = loadWorkerEnv(base)

		expect(env.NOTIFICATION_ALLOW_HTTP).toBe(false)
		expect(env.NOTIFICATION_ALLOWED_HOSTS).toBe("")
		expect(env.NOTIFICATION_ALLOWED_ADDRESSES).toBe("")
	})

	it("reads false as false, rather than as any string at all being true", () => {
		expect(
			loadWorkerEnv({ ...base, NOTIFICATION_ALLOW_HTTP: "false" }).NOTIFICATION_ALLOW_HTTP,
		).toBe(false)
		expect(
			loadWorkerEnv({ ...base, NOTIFICATION_ALLOW_HTTP: "true" }).NOTIFICATION_ALLOW_HTTP,
		).toBe(true)
	})

	it("refuses a word it was not offered rather than reading it as one or the other", () => {
		expect(() => loadWorkerEnv({ ...base, NOTIFICATION_ALLOW_HTTP: "off" })).toThrow()
		expect(() => loadWorkerEnv({ ...base, NOTIFICATION_ALLOW_HTTP: "no" })).toThrow()
		expect(() => loadWorkerEnv({ ...base, NOTIFICATION_ALLOW_HTTP: "0" })).toThrow()
		expect(() => loadWorkerEnv({ ...base, NOTIFICATION_ALLOW_HTTP: "" })).toThrow()
	})

	it("refuses to start on an address list it cannot read, rather than sending nowhere", () => {
		expect(
			loadWorkerEnv({ ...base, NOTIFICATION_ALLOWED_ADDRESSES: "10.0.0.0/8, 127.0.0.1" })
				.NOTIFICATION_ALLOWED_ADDRESSES,
		).toBe("10.0.0.0/8, 127.0.0.1")
		expect(() =>
			loadWorkerEnv({ ...base, NOTIFICATION_ALLOWED_ADDRESSES: "10.0.0.0/64" }),
		).toThrow()
		expect(() => loadWorkerEnv({ ...base, NOTIFICATION_ALLOWED_ADDRESSES: "nonsense" })).toThrow()
	})
})

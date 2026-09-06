import { generateKeyPair } from "@open-mcc/core"
import { describe, expect, it, vi } from "vitest"
import { startServer } from "./bootstrap"
import type { Env } from "./env"

const baseEnv = (overrides: Partial<Env> = {}): Env => ({
	DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
	PORT: 0,
	STATUS_RETENTION_DAYS: 30,
	BETTER_AUTH_SECRET: "a-very-long-test-secret-value",
	BETTER_AUTH_URL: "http://localhost:3000",
	SEALBOX_KEYS: "",
	ALLOWED_ORIGINS: "http://localhost:5173",
	...overrides,
})

const splitKeyEntry = (entry: string): { pub: string; priv: string } => {
	const parts = entry.split(":")
	const pub = parts[1]
	const priv = parts[2]
	if (!pub || !priv) throw new Error("test setup: malformed generated key pair")
	return { pub, priv }
}

describe("startServer secret store gate", () => {
	it("fails startup on a mismatched key pair and never calls serve", async () => {
		const a = splitKeyEntry(await generateKeyPair("k1"))
		const b = splitKeyEntry(await generateKeyPair("k2"))
		const env = baseEnv({ SEALBOX_KEYS: `k1:${a.pub}:${b.priv}` })
		const serveFn = vi.fn()

		await expect(startServer(env, serveFn)).rejects.toThrow(/self-test/i)
		expect(serveFn).not.toHaveBeenCalled()
	})

	it("fails startup on an empty key set and never calls serve", async () => {
		const env = baseEnv({ SEALBOX_KEYS: "" })
		const serveFn = vi.fn()

		await expect(startServer(env, serveFn)).rejects.toThrow(/at least one key/i)
		expect(serveFn).not.toHaveBeenCalled()
	})
})

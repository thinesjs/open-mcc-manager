import { generateKeyPair } from "@open-mcc/core"
import type { Db } from "@open-mcc/db"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "./env"

const createdDbs: Db[] = []

vi.mock("@open-mcc/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@open-mcc/db")>()
	return {
		...actual,
		createDb: (url: string) => {
			const db = actual.createDb(url)
			vi.spyOn(db, "destroy")
			createdDbs.push(db)
			return db
		},
	}
})

const { startServer } = await import("./bootstrap")
const { acquireSingletonLock } = await import("./singleton")

const url = process.env.TEST_DATABASE_URL ?? ""

const baseEnv = async (): Promise<Env> => ({
	DATABASE_URL: url,
	PORT: 0,
	BETTER_AUTH_SECRET: "a-very-long-test-secret-value",
	BETTER_AUTH_URL: "http://localhost:3000",
	SEALBOX_KEYS: await generateKeyPair("k1"),
	ALLOWED_ORIGINS: "http://localhost:5173",
	INSTANCES_ROOT: "/srv/open-mcc",
})

afterEach(async () => {
	const leaked = createdDbs.splice(0, createdDbs.length)
	for (const db of leaked) {
		try {
			await db.destroy()
		} catch {
			console.error("bootstrap-singleton.test.ts teardown: pool was already destroyed")
		}
	}
})

describe("startServer singleton lock gate", () => {
	it("closes the connection pool it opened when another replica already holds the lock", async () => {
		const holder = await acquireSingletonLock(url)
		expect(holder.acquired).toBe(true)
		const serveFn = vi.fn()

		try {
			await expect(startServer(await baseEnv(), serveFn)).rejects.toThrow(/singleton lock/i)
		} finally {
			await holder.release()
		}

		expect(serveFn).not.toHaveBeenCalled()
		expect(createdDbs).toHaveLength(1)
		expect(createdDbs[0]?.destroy).toHaveBeenCalled()
	})
})

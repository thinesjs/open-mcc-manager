import { createDb } from "@open-mcc/db"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { tracedDialect } from "./query-span"
import { startTracing } from "./tracing"

const url = process.env.TEST_DATABASE_URL ?? ""

describe("a traced dialect against a real database", () => {
	const handle = startTracing({ service: "query-span", endpoint: "http://127.0.0.1:4318" })
	const db = createDb(url, tracedDialect)

	afterAll(async () => {
		await db.destroy()
		await handle.shutdown()
	})

	it("still runs an ordinary query", async () => {
		const result = await sql<{ answer: number }>`select 1 as answer`.execute(db)
		expect(result.rows[0]?.answer).toBe(1)
	})

	it("still runs a transaction, which routes through the same connection", async () => {
		const seen = await db.transaction().execute(async (tx) => {
			const inner = await sql<{ answer: number }>`select 2 as answer`.execute(tx)
			return inner.rows[0]?.answer
		})
		expect(seen).toBe(2)
	})

	it("surfaces a failing query as a rejection rather than swallowing it", async () => {
		await expect(sql`select * from a_table_that_is_not_there`.execute(db)).rejects.toThrow()
	})

	it("keeps working after a failure, so the span's finally did not break the connection", async () => {
		await expect(sql`select * from still_not_there`.execute(db)).rejects.toThrow()
		const result = await sql<{ answer: number }>`select 3 as answer`.execute(db)
		expect(result.rows[0]?.answer).toBe(3)
	})
})

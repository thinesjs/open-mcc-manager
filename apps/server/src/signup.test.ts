import { randomUUID } from "node:crypto"
import { createDb, type Db } from "@open-mcc/db"
import { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createAuth } from "./auth"

let db: Db
let app: Hono

beforeAll(() => {
	db = createDb(process.env.TEST_DATABASE_URL ?? "")
	const auth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000")
	app = new Hono()
	app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
})

afterAll(async () => {
	await db.destroy()
})

describe("public registration", () => {
	it("rejects the public sign-up endpoint by default", async () => {
		const res = await app.request("/api/auth/sign-up/email", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				email: `${randomUUID()}@example.com`,
				password: "correct horse battery staple 3",
				name: "Uninvited",
			}),
		})
		expect(res.status).not.toBe(200)

		const rows = await db.selectFrom("user").select("id").limit(1).executeTakeFirst()
		expect(rows).toBeUndefined()
	})
})

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
		const email = `${randomUUID()}@example.com`
		const res = await app.request("/api/auth/sign-up/email", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				email,
				password: "correct horse battery staple 3",
				name: "Uninvited",
			}),
		})
		expect(res.status).not.toBe(200)

		const created = await db
			.selectFrom("user")
			.select("id")
			.where("email", "=", email)
			.executeTakeFirst()
		expect(created).toBeUndefined()
	})
})

describe("argon2id wiring", () => {
	it("stores a hash matching the register's parameters when a user signs up through the real auth stack", async () => {
		const signupAuth = createAuth(
			db,
			"a-very-long-test-secret-value-000000",
			"http://localhost:3000",
			{ disableSignUp: false, disableRateLimit: true },
		)
		const email = `${randomUUID()}@example.com`
		const signUpResult = await signupAuth.api.signUpEmail({
			body: { email, password: "correct horse battery staple 4", name: "Argon Check" },
		})

		try {
			const account = await db
				.selectFrom("account")
				.select("password")
				.where("userId", "=", signUpResult.user.id)
				.executeTakeFirst()
			const hash = account?.password ?? ""
			expect(hash.startsWith("$argon2id$")).toBe(true)
			expect(hash).toContain("m=19456,t=2,p=1")
		} finally {
			await db.deleteFrom("session").where("userId", "=", signUpResult.user.id).execute()
			await db.deleteFrom("account").where("userId", "=", signUpResult.user.id).execute()
			await db.deleteFrom("user").where("id", "=", signUpResult.user.id).execute()
		}
	})
})

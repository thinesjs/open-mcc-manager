import { randomUUID } from "node:crypto"
import { createDb, type Db } from "@open-mcc/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Auth, createAuth } from "./auth"

const ORIGIN = "http://localhost:5173"
const PASSWORD = "correct horse battery staple 7"
const EMAIL = `active-${randomUUID().slice(0, 8)}@example.com`

let db: Db
let auth: Auth
let organizationId = ""

beforeAll(async () => {
	db = createDb(process.env.TEST_DATABASE_URL ?? "")
	auth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000", {
		trustedOrigins: [ORIGIN],
		disableSignUp: false,
		userCreation: "trusted",
		disableRateLimit: true,
	})

	organizationId = randomUUID()
	await db
		.insertInto("organization")
		.values({
			id: organizationId,
			name: "Active Org",
			slug: `active-${randomUUID().slice(0, 8)}`,
			createdAt: new Date(),
		})
		.execute()
})

afterAll(async () => {
	await db.deleteFrom("member").where("organizationId", "=", organizationId).execute()
	await db.deleteFrom("organization").where("id", "=", organizationId).execute()
	await db.destroy()
})

const post = async (path: string, body: Record<string, string>) =>
	await auth.handler(
		new Request(`http://localhost:3000/api/auth/${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN },
			body: JSON.stringify(body),
		}),
	)

describe("a session knows which organization it belongs to", () => {
	it("sets the active organization on sign-in, without which the dashboard bounces to sign-in", async () => {
		expect(
			(await post("sign-up/email", { email: EMAIL, password: PASSWORD, name: "A" })).status,
		).toBe(200)

		const user = await db
			.selectFrom("user")
			.select("id")
			.where("email", "=", EMAIL)
			.executeTakeFirstOrThrow()

		await db
			.insertInto("member")
			.values({
				id: randomUUID(),
				organizationId,
				userId: user.id,
				role: "owner",
				createdAt: new Date(),
			})
			.execute()

		expect((await post("sign-in/email", { email: EMAIL, password: PASSWORD })).status).toBe(200)

		const session = await db
			.selectFrom("session")
			.select("activeOrganizationId")
			.where("userId", "=", user.id)
			.orderBy("createdAt", "desc")
			.executeTakeFirstOrThrow()

		expect(session.activeOrganizationId).toBe(organizationId)
	})
})

import { randomUUID } from "node:crypto"
import { createDb, type Db } from "@open-mcc/db"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type Auth, createAuth } from "./auth"

const ORIGIN = "http://localhost:5173"
const PASSWORD = "correct horse battery staple 7"

let db: Db
let auth: Auth
let organizationId = ""
let seededEmails: string[] = []

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

afterEach(async () => {
	const emails = seededEmails
	seededEmails = []
	await db.deleteFrom("member").where("organizationId", "=", organizationId).execute()
	if (emails.length === 0) return
	await db
		.deleteFrom("session")
		.where("userId", "in", (qb) => qb.selectFrom("user").select("id").where("email", "in", emails))
		.execute()
	await db
		.deleteFrom("account")
		.where("userId", "in", (qb) => qb.selectFrom("user").select("id").where("email", "in", emails))
		.execute()
	await db.deleteFrom("user").where("email", "in", emails).execute()
})

afterAll(async () => {
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

const seededEmail = (): string => {
	const email = `active-${randomUUID().slice(0, 8)}@example.com`
	seededEmails.push(email)
	return email
}

describe("a session knows which organization it belongs to", () => {
	it("sets the active organization on sign-in, without which the dashboard bounces to sign-in", async () => {
		const email = seededEmail()
		expect((await post("sign-up/email", { email, password: PASSWORD, name: "A" })).status).toBe(200)

		const user = await db
			.selectFrom("user")
			.select("id")
			.where("email", "=", email)
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

		expect((await post("sign-in/email", { email, password: PASSWORD })).status).toBe(200)

		const session = await db
			.selectFrom("session")
			.select("activeOrganizationId")
			.where("userId", "=", user.id)
			.orderBy("createdAt", "desc")
			.executeTakeFirstOrThrow()

		expect(session.activeOrganizationId).toBe(organizationId)
	})

	it("leaves no session behind for a later test to inherit", async () => {
		const leftover = await db
			.selectFrom("session")
			.select("id")
			.where("activeOrganizationId", "=", organizationId)
			.execute()
		expect(leftover).toHaveLength(0)
	})
})

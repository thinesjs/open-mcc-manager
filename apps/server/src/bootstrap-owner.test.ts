import { randomUUID } from "node:crypto"
import { createDb, type Db } from "@open-mcc/db"
import { describe, expect, it } from "vitest"
import { createAuth } from "./auth"
import { bootstrapOwner, UsersAlreadyExistError } from "./bootstrap-owner"

let db: Db

const getDb = (): Db => {
	if (!db) db = createDb(process.env.TEST_DATABASE_URL ?? "")
	return db
}

describe("bootstrapOwner", () => {
	it("creates the first owner and organization when no user exists", async () => {
		const database = getDb()
		const before = await database.selectFrom("user").select("id").limit(1).executeTakeFirst()
		expect(before).toBeUndefined()

		const auth = createAuth(
			database,
			"a-very-long-test-secret-value-000000",
			"http://localhost:3000",
			{
				disableSignUp: false,
			},
		)
		const email = `${randomUUID()}@example.com`
		const result = await bootstrapOwner(database, auth, {
			email,
			password: "correct horse battery staple 1",
			name: "First Owner",
			organizationName: "Bootstrap Org",
			organizationSlug: `org-${randomUUID()}`,
		})

		expect(result.userId.length).toBeGreaterThan(0)
		expect(result.organizationId.length).toBeGreaterThan(0)

		const member = await database
			.selectFrom("member")
			.select("role")
			.where("organizationId", "=", result.organizationId)
			.where("userId", "=", result.userId)
			.executeTakeFirst()
		expect(member?.role).toBe("owner")

		await database
			.deleteFrom("member")
			.where("organizationId", "=", result.organizationId)
			.execute()
		await database.deleteFrom("organization").where("id", "=", result.organizationId).execute()
		await database.deleteFrom("session").where("userId", "=", result.userId).execute()
		await database.deleteFrom("account").where("userId", "=", result.userId).execute()
		await database.deleteFrom("user").where("id", "=", result.userId).execute()
	})

	it("refuses when a user already exists, without creating an organization", async () => {
		const database = getDb()
		const existingUserId = randomUUID()
		await database
			.insertInto("user")
			.values({ id: existingUserId, name: "Existing", email: `${randomUUID()}@example.com` })
			.execute()

		const auth = createAuth(
			database,
			"a-very-long-test-secret-value-000000",
			"http://localhost:3000",
			{
				disableSignUp: false,
			},
		)

		await expect(
			bootstrapOwner(database, auth, {
				email: `${randomUUID()}@example.com`,
				password: "correct horse battery staple 2",
				name: "Second Owner",
				organizationName: "Should Not Exist",
				organizationSlug: `org-${randomUUID()}`,
			}),
		).rejects.toThrow(UsersAlreadyExistError)

		const org = await database
			.selectFrom("organization")
			.select("id")
			.where("name", "=", "Should Not Exist")
			.executeTakeFirst()
		expect(org).toBeUndefined()

		await database.deleteFrom("user").where("id", "=", existingUserId).execute()
	})
})

import { randomUUID } from "node:crypto"
import { createDb, type Db, migrateToLatest } from "@open-mcc/db"
import { Client } from "pg"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type Auth, createAuth } from "./auth"
import { bootstrapOwner, UsersAlreadyExistError } from "./bootstrap-owner"

const adminUrl = process.env.TEST_DATABASE_URL ?? ""
const databaseName = `bootstrap_owner_test_${randomUUID().replaceAll("-", "")}`

let databaseUrl: string
let db: Db
let auth: Auth

const onConnection = async (connectionString: string, statement: string): Promise<void> => {
	const client = new Client({ connectionString })
	await client.connect()
	try {
		await client.query(statement)
	} finally {
		await client.end()
	}
}

const resetOwnedDatabase = async (): Promise<void> => {
	const tables = await db.introspection.getTables()
	const names = tables
		.filter((table) => !table.isView)
		.map((table) => `"${table.name}"`)
		.join(", ")
	await onConnection(databaseUrl, `truncate table ${names} restart identity cascade`)
}

const SESSIONS_GONE_TIMEOUT_MS = 10_000

const openSessions = async (): Promise<number> => {
	const client = new Client({ connectionString: adminUrl })
	await client.connect()
	try {
		const result = await client.query<{ open: number }>(
			"select count(*)::int as open from pg_stat_activity where datname = $1",
			[databaseName],
		)
		return result.rows[0]?.open ?? 0
	} finally {
		await client.end()
	}
}

const untilSessionsGone = async (): Promise<void> => {
	const deadline = Date.now() + SESSIONS_GONE_TIMEOUT_MS
	while ((await openSessions()) > 0) {
		if (Date.now() > deadline) throw new Error(`sessions still open on ${databaseName}`)
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}

beforeAll(async () => {
	await onConnection(adminUrl, `create database "${databaseName}"`)
	const url = new URL(adminUrl)
	url.pathname = `/${databaseName}`
	databaseUrl = url.toString()
	db = createDb(databaseUrl)
	const { error } = await migrateToLatest(db)
	if (error) throw error
	auth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000", {
		disableSignUp: false,
		disableRateLimit: true,
		allowOrganizationCreation: true,
	})
})

afterEach(async () => {
	await resetOwnedDatabase()
})

afterAll(async () => {
	await db.destroy()
	await untilSessionsGone()
	await onConnection(adminUrl, `drop database "${databaseName}"`)
})

describe("bootstrapOwner", () => {
	it("creates the first owner and organization when no user exists", async () => {
		const before = await db.selectFrom("user").select("id").limit(1).executeTakeFirst()
		expect(before).toBeUndefined()

		const email = `${randomUUID()}@example.com`
		const result = await bootstrapOwner(databaseUrl, db, auth, {
			email,
			password: "correct horse battery staple 1",
			name: "First Owner",
			organizationName: "Bootstrap Org",
			organizationSlug: `org-${randomUUID()}`,
		})

		expect(result.userId.length).toBeGreaterThan(0)
		expect(result.organizationId.length).toBeGreaterThan(0)

		const member = await db
			.selectFrom("member")
			.select("role")
			.where("organizationId", "=", result.organizationId)
			.where("userId", "=", result.userId)
			.executeTakeFirst()
		expect(member?.role).toBe("owner")
	})

	it("refuses when a user already exists, without creating an organization", async () => {
		await db
			.insertInto("user")
			.values({ id: randomUUID(), name: "Existing", email: `${randomUUID()}@example.com` })
			.execute()

		await expect(
			bootstrapOwner(databaseUrl, db, auth, {
				email: `${randomUUID()}@example.com`,
				password: "correct horse battery staple 2",
				name: "Second Owner",
				organizationName: "Should Not Exist",
				organizationSlug: `org-${randomUUID()}`,
			}),
		).rejects.toThrow(UsersAlreadyExistError)

		const org = await db
			.selectFrom("organization")
			.select("id")
			.where("name", "=", "Should Not Exist")
			.executeTakeFirst()
		expect(org).toBeUndefined()
	})

	it("serializes two concurrent bootstraps against an empty database so exactly one wins", async () => {
		const before = await db.selectFrom("user").select("id").limit(1).executeTakeFirst()
		expect(before).toBeUndefined()

		const first = bootstrapOwner(databaseUrl, db, auth, {
			email: `${randomUUID()}@example.com`,
			password: "correct horse battery staple 3",
			name: "Racer One",
			organizationName: "Race Org One",
			organizationSlug: `org-${randomUUID()}`,
		})
		const second = bootstrapOwner(databaseUrl, db, auth, {
			email: `${randomUUID()}@example.com`,
			password: "correct horse battery staple 4",
			name: "Racer Two",
			organizationName: "Race Org Two",
			organizationSlug: `org-${randomUUID()}`,
		})

		const results = await Promise.allSettled([first, second])
		const fulfilled = results.filter((result) => result.status === "fulfilled")
		const rejected = results.filter((result) => result.status === "rejected")
		expect(fulfilled).toHaveLength(1)
		expect(rejected).toHaveLength(1)
		if (rejected[0]?.status === "rejected") {
			expect(rejected[0].reason).toBeInstanceOf(UsersAlreadyExistError)
		}

		const users = await db.selectFrom("user").select("id").execute()
		expect(users).toHaveLength(1)
		const organizations = await db.selectFrom("organization").select("id").execute()
		expect(organizations).toHaveLength(1)
	})
})

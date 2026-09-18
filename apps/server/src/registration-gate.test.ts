import { randomUUID } from "node:crypto"
import { REGISTRATION_CLOSED_CODE, REGISTRATION_CLOSED_MESSAGE } from "@open-mcc/contracts"
import { createDb, type Db, migrateToLatest } from "@open-mcc/db"
import type { ValidateUserInfoSource } from "better-auth"
import { Hono } from "hono"
import { Client } from "pg"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type Auth, createAuth } from "./auth"
import { bootstrapOwner } from "./bootstrap-owner"
import { alwaysRefuses, anyUserExists, createRegistrationGate } from "./security/registration-gate"

const adminUrl = process.env.TEST_DATABASE_URL ?? ""
const databaseName = `registration_gate_test_${randomUUID().replaceAll("-", "")}`
const secret = "a-very-long-test-secret-value-000000"
const baseUrl = "http://localhost:3000"
const dashboardOrigin = "http://localhost:5173"

let databaseUrl: string
let db: Db
let gatedAuth: Auth
let trustedAuth: Auth
let closedAuth: Auth
let gatedApp: Hono
let closedApp: Hono

const onConnection = async (connectionString: string, statement: string): Promise<void> => {
	const client = new Client({ connectionString })
	await client.connect()
	try {
		await client.query(statement)
	} finally {
		await client.end()
	}
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

const resetOwnedDatabase = async (): Promise<void> => {
	const tables = await db.introspection.getTables()
	const names = tables
		.filter((table) => !table.isView)
		.map((table) => `"${table.name}"`)
		.join(", ")
	await onConnection(databaseUrl, `truncate table ${names} restart identity cascade`)
}

const insertUser = async (): Promise<string> => {
	const id = randomUUID()
	await db
		.insertInto("user")
		.values({ id, name: "Existing Owner", email: `${randomUUID()}@example.com` })
		.execute()
	return id
}

const signUpRequest = (email: string, password: string): Request =>
	new Request(`${baseUrl}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password, name: "Uninvited" }),
	})

const createUserSource = (method: string): ValidateUserInfoSource => ({
	action: "create-user",
	method,
	oauth: method === "oauth" ? { providerId: "google" } : undefined,
	sso: method.startsWith("sso-") ? { providerId: "corporate-idp" } : undefined,
})

beforeAll(async () => {
	await onConnection(adminUrl, `create database "${databaseName}"`)
	const url = new URL(adminUrl)
	url.pathname = `/${databaseName}`
	databaseUrl = url.toString()
	db = createDb(databaseUrl)
	const { error } = await migrateToLatest(db)
	if (error) throw error
	gatedAuth = createAuth(db, secret, baseUrl, {
		disableSignUp: false,
		disableRateLimit: true,
		trustedOrigins: [dashboardOrigin],
	})
	trustedAuth = createAuth(db, secret, baseUrl, {
		disableSignUp: false,
		disableRateLimit: true,
		userCreation: "trusted",
		trustedOrigins: [dashboardOrigin],
	})
	closedAuth = createAuth(db, secret, baseUrl, {
		disableSignUp: false,
		disableRateLimit: true,
		userCreation: "closed",
		trustedOrigins: [dashboardOrigin],
	})
	gatedApp = new Hono()
	gatedApp.on(["GET", "POST"], "/api/auth/*", (c) => gatedAuth.handler(c.req.raw))
	closedApp = new Hono()
	closedApp.on(["GET", "POST"], "/api/auth/*", (c) => closedAuth.handler(c.req.raw))
})

afterEach(async () => {
	await resetOwnedDatabase()
})

afterAll(async () => {
	await db.destroy()
	await untilSessionsGone()
	await onConnection(adminUrl, `drop database "${databaseName}"`)
})

describe("the registration gate", () => {
	it("admits a create-user attempt while the deployment holds no user", async () => {
		expect(await anyUserExists(db)).toBe(false)

		const email = `${randomUUID()}@example.com`
		const res = await gatedApp.fetch(signUpRequest(email, "correct horse battery staple 1"))

		expect(res.status).toBe(200)
		const created = await db
			.selectFrom("user")
			.select("id")
			.where("email", "=", email)
			.executeTakeFirst()
		expect(created).toBeDefined()
	})

	it("rejects an email and password sign-up once a user exists", async () => {
		await insertUser()

		const email = `${randomUUID()}@example.com`
		const res = await gatedApp.fetch(signUpRequest(email, "correct horse battery staple 2"))

		expect(res.status).toBe(403)
		expect(await res.text()).toContain(REGISTRATION_CLOSED_CODE)
		const created = await db
			.selectFrom("user")
			.select("id")
			.where("email", "=", email)
			.executeTakeFirst()
		expect(created).toBeUndefined()
	})

	it("rejects an oauth create-user once a user exists, the side door disableSignUp cannot close", async () => {
		await insertUser()
		const gate = createRegistrationGate(() => anyUserExists(db))

		const result = await gate({ source: createUserSource("oauth") })

		expect(result?.error).toBe(REGISTRATION_CLOSED_CODE)
	})

	it("rejects an sso-oidc create-user once a user exists", async () => {
		await insertUser()
		const gate = createRegistrationGate(() => anyUserExists(db))

		const result = await gate({ source: createUserSource("sso-oidc") })

		expect(result?.error).toBe(REGISTRATION_CLOSED_CODE)
	})

	it("rejects a create-user attempt from every method better-auth can report", async () => {
		await insertUser()
		const gate = createRegistrationGate(() => anyUserExists(db))
		const methods = [
			"oauth",
			"sso-oidc",
			"sso-saml",
			"email-password",
			"magic-link",
			"email-otp",
			"anonymous",
			"siwe",
			"phone-number",
			"admin",
			"scim",
		]

		const rejected = await Promise.all(
			methods.map(async (method) => (await gate({ source: createUserSource(method) }))?.error),
		)

		expect(rejected).toEqual(methods.map(() => REGISTRATION_CLOSED_CODE))
	})

	it("admits link-account and sign-in so an existing user keeps signing in", async () => {
		await insertUser()
		const gate = createRegistrationGate(() => anyUserExists(db))

		const linked = await gate({ source: { ...createUserSource("oauth"), action: "link-account" } })
		const signedIn = await gate({ source: { ...createUserSource("oauth"), action: "sign-in" } })

		expect(linked).toBeUndefined()
		expect(signedIn).toBeUndefined()
	})

	it("names no address, port, credential or internal detail when it rejects", async () => {
		await insertUser()
		const email = `${randomUUID()}@example.com`
		const password = "correct horse battery staple 3"

		const res = await gatedApp.fetch(signUpRequest(email, password))
		const body = await res.text()

		for (const secretish of [
			email,
			password,
			"postgres",
			"localhost",
			"25433",
			"5432",
			databaseName,
			secret,
		]) {
			expect(body).not.toContain(secretish)
		}
		expect(REGISTRATION_CLOSED_MESSAGE).not.toContain("@")
		expect(body).toContain(REGISTRATION_CLOSED_MESSAGE)
	})

	it("installs the gate on a default instance and leaves a trusted instance ungated", () => {
		const publicAuth = createAuth(db, secret, baseUrl)

		expect(typeof publicAuth.options.user?.validateUserInfo).toBe("function")
		expect(typeof gatedAuth.options.user?.validateUserInfo).toBe("function")
		expect(typeof closedAuth.options.user?.validateUserInfo).toBe("function")
		expect(trustedAuth.options.user?.validateUserInfo).toBeUndefined()
	})

	it("refuses a create-user on a closed instance while the deployment still holds no user", async () => {
		expect(await anyUserExists(db)).toBe(false)

		const email = `${randomUUID()}@example.com`
		const res = await closedApp.fetch(signUpRequest(email, "correct horse battery staple 6"))
		const body = await res.text()

		expect(res.status).toBe(403)
		expect(body).toContain(REGISTRATION_CLOSED_MESSAGE)
		expect(await db.selectFrom("user").select("id").execute()).toEqual([])
	})

	it("still admits link-account and sign-in on a closed instance, so a member keeps signing in", async () => {
		const gate = createRegistrationGate(alwaysRefuses)

		const linked = await gate({ source: { ...createUserSource("oauth"), action: "link-account" } })
		const signedIn = await gate({ source: { ...createUserSource("oauth"), action: "sign-in" } })

		expect(linked).toBeUndefined()
		expect(signedIn).toBeUndefined()
	})

	it("still bootstraps the first owner through the gated cli path on an empty deployment", async () => {
		const cliAuth = createAuth(db, secret, baseUrl, {
			disableSignUp: false,
			disableRateLimit: true,
			allowOrganizationCreation: true,
		})
		expect(typeof cliAuth.options.user?.validateUserInfo).toBe("function")

		const result = await bootstrapOwner(databaseUrl, db, cliAuth, {
			email: `${randomUUID()}@example.com`,
			password: "correct horse battery staple 4",
			name: "First Owner",
			organizationName: "Bootstrap Org",
			organizationSlug: `org-${randomUUID()}`,
		})

		expect(result.userId.length).toBeGreaterThan(0)
		expect(result.organizationId.length).toBeGreaterThan(0)
	})

	it("still admits an invited member through the trusted instance once a user exists", async () => {
		await insertUser()

		const invited = await trustedAuth.api.signUpEmail({
			body: {
				email: `${randomUUID()}@example.com`,
				password: "correct horse battery staple 5",
				name: "Invited Member",
			},
		})

		expect(invited.user.id.length).toBeGreaterThan(0)
	})
})

import { randomUUID } from "node:crypto"
import { serve } from "@hono/node-server"
import {
	OIDC_PROVIDER_ID,
	REGISTRATION_CLOSED_CODE,
	REGISTRATION_CLOSED_MESSAGE,
} from "@open-mcc/contracts"
import { createLogger, generateKeyPair } from "@open-mcc/core"
import { createDb, type Db, migrateToLatest } from "@open-mcc/db"
import { Hono } from "hono"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createAuth } from "./auth"
import { mountDashboardAuth } from "./auth-routes"
import { type ServerHandle, startServer } from "./bootstrap"
import { bootstrapOwner } from "./bootstrap-owner"
import type { Env } from "./env"
import { oidcProviderFrom } from "./oidc-env"
import { anyUserExists } from "./security/registration-gate"

vi.mock("@open-mcc/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@open-mcc/core")>()
	return {
		...actual,
		startScheduler: () => ({ stop: () => undefined }),
		startHealthPoller: () => ({ stop: () => undefined }),
	}
})

const STARTUP_TIMEOUT_MS = 60_000

const ORIGIN = "http://localhost:5173"
const BASE_URL = "http://localhost:3000"
const SECRET = "a-very-long-test-secret-value-000000"
const PASSWORD = "correct horse battery staple 1"
const PROVIDER_NAME = "Acme ID"
const CLIENT_SECRET = "idp-client-secret-never-leaves-the-server"

type Identity = { subject: string; email: string; emailConfirmed: boolean }

let issuer = ""
let identity: Identity = { subject: "", email: "", emailConfirmed: false }
let tokenRequests: string[] = []

const provider = new Hono()
provider.get("/.well-known/openid-configuration", (c) =>
	c.json({
		issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: `${issuer}/token`,
		userinfo_endpoint: `${issuer}/userinfo`,
		id_token_signing_alg_values_supported: ["RS256"],
		response_types_supported: ["code"],
		subject_types_supported: ["public"],
	}),
)
provider.post("/token", async (c) => {
	tokenRequests.push(await c.req.text())
	return c.json({ access_token: "idp-access-token", token_type: "Bearer", expires_in: 3600 })
})
provider.get("/userinfo", (c) =>
	c.json({
		sub: identity.subject,
		email: identity.email,
		email_verified: identity.emailConfirmed,
		name: "Signed In Person",
	}),
)

const env = async (): Promise<Env> => ({
	DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
	PORT: 0,
	STATUS_RETENTION_DAYS: 30,
	BETTER_AUTH_SECRET: SECRET,
	BETTER_AUTH_URL: BASE_URL,
	SEALBOX_KEYS: await generateKeyPair("k1"),
	ALLOWED_ORIGINS: ORIGIN,
	NOTIFICATION_ALLOW_HTTP: false,
	NOTIFICATION_ALLOWED_HOSTS: "",
	NOTIFICATION_ALLOWED_ADDRESSES: "",
	NOTIFICATION_TEAMS_HOSTS: "",
	OTEL_EXPORTER_OTLP_ENDPOINT: "",
	OIDC_ISSUER_URL: issuer,
	OIDC_CLIENT_ID: "open-mcc-manager",
	OIDC_CLIENT_SECRET: CLIENT_SECRET,
	OIDC_NAME: PROVIDER_NAME,
})

let handle: ServerHandle
let db: Db
let seedAuth: ReturnType<typeof createAuth>
let providerServer: ReturnType<typeof serve>
const logLines: string[] = []

const listen = async (): Promise<number> =>
	await new Promise((resolve) => {
		providerServer = serve({ fetch: provider.fetch, port: 0 }, (info) => resolve(info.port))
	})

beforeAll(async () => {
	issuer = `http://127.0.0.1:${await listen()}`
	const logger = createLogger({
		write: (line: string) => {
			logLines.push(line)
		},
	})
	handle = await startServer(await env(), vi.fn(), logger)
	db = createDb(process.env.TEST_DATABASE_URL ?? "")
	seedAuth = createAuth(db, SECRET, BASE_URL, {
		disableSignUp: false,
		disableRateLimit: true,
		allowOrganizationCreation: true,
		userCreation: "trusted",
		trustedOrigins: [ORIGIN],
	})
}, STARTUP_TIMEOUT_MS)

afterAll(async () => {
	handle.scheduler.stop()
	handle.healthPoller.stop()
	handle.heartbeat.stop()
	await handle.boss.stop({ graceful: false })
	await handle.lock.release()
	await handle.db.destroy()
	await db.destroy()
	providerServer.close()
})

const authorizeSchema = z.object({ url: z.string().url(), redirect: z.boolean() })

let lastClientAddress = 0

const forwardedFor = (): string => {
	lastClientAddress += 1
	return `198.51.100.${lastClientAddress}`
}

type Started = { state: string; cookie: string; authorizeUrl: URL }

const startSingleSignOn = async (app: Hono, ip: string): Promise<Started> => {
	const res = await app.request("/api/auth/sign-in/social", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, "x-forwarded-for": ip },
		body: JSON.stringify({
			provider: OIDC_PROVIDER_ID,
			callbackURL: `${ORIGIN}/hosts`,
			errorCallbackURL: `${ORIGIN}/sign-in`,
		}),
	})
	expect(res.status, await res.clone().text()).toBe(200)
	const authorizeUrl = new URL(authorizeSchema.parse(await res.json()).url)
	return {
		state: authorizeUrl.searchParams.get("state") ?? "",
		cookie: res.headers
			.getSetCookie()
			.map((each) => each.split(";")[0])
			.join("; "),
		authorizeUrl,
	}
}

const completeSingleSignOn = async (app: Hono, started: Started, ip: string): Promise<Response> =>
	await app.request(
		`/api/auth/callback/${OIDC_PROVIDER_ID}?code=authorization-code&state=${encodeURIComponent(started.state)}`,
		{ method: "GET", headers: { Cookie: started.cookie, "x-forwarded-for": ip } },
	)

const signInThrough = async (app: Hono, who: Identity): Promise<Response> => {
	identity = who
	const ip = forwardedFor()
	return await completeSingleSignOn(app, await startSingleSignOn(app, ip), ip)
}

const seedMember = async (role: string) => {
	const email = `${randomUUID()}@example.com`
	const created = await seedAuth.api.signUpEmail({
		body: { email, password: PASSWORD, name: "Invited Operator" },
	})
	const organization = await seedAuth.api.createOrganization({
		body: { name: "Single Sign-On Org", slug: `org-${randomUUID()}`, userId: created.user.id },
	})
	const organizationId = organization?.id ?? ""
	const memberId = randomUUID()
	await db
		.deleteFrom("member")
		.where("organizationId", "=", organizationId)
		.where("userId", "=", created.user.id)
		.execute()
	await db
		.insertInto("member")
		.values({ id: memberId, organizationId, userId: created.user.id, role })
		.execute()
	await db.deleteFrom("session").where("userId", "=", created.user.id).execute()
	return { email, userId: created.user.id, organizationId, memberId }
}

const usersWith = async (email: string) =>
	await db.selectFrom("user").select(["id", "email"]).where("email", "=", email).execute()

const locationOf = (res: Response): URL => new URL(res.headers.get("location") ?? "")

describe("signing in through the configured provider", () => {
	it("lands an invited operator on their own member row, keeping the role they were invited with", async () => {
		const invited = await seedMember("operator")

		const res = await signInThrough(handle.app, {
			subject: `subject-${randomUUID()}`,
			email: invited.email,
			emailConfirmed: true,
		})

		expect(res.status, await res.clone().text()).toBe(302)
		expect(locationOf(res).toString()).toBe(`${ORIGIN}/hosts`)
		expect((await usersWith(invited.email)).map((row) => row.id)).toEqual([invited.userId])
		const members = await db
			.selectFrom("member")
			.select(["id", "role", "organizationId"])
			.where("userId", "=", invited.userId)
			.execute()
		expect(members).toEqual([
			{ id: invited.memberId, role: "operator", organizationId: invited.organizationId },
		])
		const sessions = await db
			.selectFrom("session")
			.select(["userId", "activeOrganizationId"])
			.where("userId", "=", invited.userId)
			.execute()
		expect(sessions).toEqual([
			{ userId: invited.userId, activeOrganizationId: invited.organizationId },
		])
	})

	it("links the provider identity to that same user rather than creating a second one", async () => {
		const invited = await seedMember("viewer")
		const subject = `subject-${randomUUID()}`

		await signInThrough(handle.app, { subject, email: invited.email, emailConfirmed: true })

		const accounts = await db
			.selectFrom("account")
			.select(["userId", "providerId", "accountId"])
			.where("userId", "=", invited.userId)
			.where("providerId", "=", OIDC_PROVIDER_ID)
			.execute()
		expect(accounts).toEqual([
			{ userId: invited.userId, providerId: OIDC_PROVIDER_ID, accountId: subject },
		])
		expect((await usersWith(invited.email)).length).toBe(1)
	})

	it("signs that operator back in on a later visit without asking for a password", async () => {
		const invited = await seedMember("viewer")
		const returning = {
			subject: `subject-${randomUUID()}`,
			email: invited.email,
			emailConfirmed: true,
		}
		await signInThrough(handle.app, returning)

		const again = await signInThrough(handle.app, returning)

		expect(again.status, await again.clone().text()).toBe(302)
		expect(locationOf(again).toString()).toBe(`${ORIGIN}/hosts`)
		expect((await usersWith(invited.email)).length).toBe(1)
		const accounts = await db
			.selectFrom("account")
			.select("id")
			.where("userId", "=", invited.userId)
			.where("providerId", "=", OIDC_PROVIDER_ID)
			.execute()
		expect(accounts.length).toBe(1)
	})

	it("turns away a stranger the deployment never invited, and says registration is closed", async () => {
		const stranger = `${randomUUID()}@example.com`
		const before = await db.selectFrom("user").select("id").execute()

		const res = await signInThrough(handle.app, {
			subject: `subject-${randomUUID()}`,
			email: stranger,
			emailConfirmed: true,
		})

		const location = locationOf(res)
		expect(res.status).toBe(302)
		expect(`${location.origin}${location.pathname}`).toBe(`${ORIGIN}/sign-in`)
		expect(location.searchParams.get("error")).toBe(REGISTRATION_CLOSED_CODE)
		expect(location.searchParams.get("error_description")).toBe(REGISTRATION_CLOSED_MESSAGE)
		expect(await usersWith(stranger)).toEqual([])
		const after = await db.selectFrom("user").select("id").execute()
		expect(after.length).toBe(before.length)
	})

	it("opens no session for a stranger it turned away", async () => {
		const stranger = `${randomUUID()}@example.com`
		const sessionsBefore = await db.selectFrom("session").select("id").execute()

		const res = await signInThrough(handle.app, {
			subject: `subject-${randomUUID()}`,
			email: stranger,
			emailConfirmed: true,
		})

		expect(res.headers.getSetCookie().join("; ")).not.toContain("session_token")
		const sessionsAfter = await db.selectFrom("session").select("id").execute()
		expect(sessionsAfter.length).toBe(sessionsBefore.length)
	})

	it("refuses to match an address the provider has not confirmed, even for a real member", async () => {
		const invited = await seedMember("owner")

		const res = await signInThrough(handle.app, {
			subject: `subject-${randomUUID()}`,
			email: invited.email,
			emailConfirmed: false,
		})

		expect(locationOf(res).searchParams.get("error")).toBe("account_not_linked")
		const accounts = await db
			.selectFrom("account")
			.select("id")
			.where("userId", "=", invited.userId)
			.where("providerId", "=", OIDC_PROVIDER_ID)
			.execute()
		expect(accounts).toEqual([])
		const sessions = await db
			.selectFrom("session")
			.select("id")
			.where("userId", "=", invited.userId)
			.execute()
		expect(sessions).toEqual([])
	})

	it("names no failure of its own an internal server error", async () => {
		const res = await signInThrough(handle.app, {
			subject: `subject-${randomUUID()}`,
			email: `${randomUUID()}@example.com`,
			emailConfirmed: true,
		})

		expect(locationOf(res).searchParams.get("error")).not.toBe("internal_server_error")
		expect(res.status).toBeLessThan(500)
	})
})

describe("what the deployment exposes once a provider is configured", () => {
	it("mounts the two single sign-on routes beside the five the dashboard already had", () => {
		const mounted = handle.app.routes
			.filter((route) => route.path.startsWith("/api/auth"))
			.map((route) => `${route.method} ${route.path}`)
			.sort()

		expect(mounted).toEqual([
			"GET /api/auth/callback/oidc",
			"GET /api/auth/get-session",
			"GET /api/auth/organization/list",
			"POST /api/auth/organization/set-active",
			"POST /api/auth/sign-in/email",
			"POST /api/auth/sign-in/social",
			"POST /api/auth/sign-out",
		])
	})

	it("tells a signed-out visitor the name to put on the button, and nothing else", async () => {
		const res = await handle.app.request("/trpc/system.signInOptions", {
			method: "GET",
			headers: { Origin: ORIGIN, "x-forwarded-for": forwardedFor() },
		})
		const body = await res.text()

		expect(res.status, body).toBe(200)
		expect(JSON.parse(body)).toEqual({
			result: { data: { singleSignOn: { name: PROVIDER_NAME } } },
		})
	})

	it("sends the client secret to the provider alone, never to the browser or this deployment's log", async () => {
		const invited = await seedMember("viewer")
		const ip = forwardedFor()
		tokenRequests = []

		const started = await startSingleSignOn(handle.app, ip)
		identity = { subject: `subject-${randomUUID()}`, email: invited.email, emailConfirmed: true }
		const finished = await completeSingleSignOn(handle.app, started, ip)

		expect(tokenRequests.join(" ")).toContain(CLIENT_SECRET)
		expect(started.authorizeUrl.toString()).not.toContain(CLIENT_SECRET)
		expect(started.cookie).not.toContain(CLIENT_SECRET)
		expect(await finished.clone().text()).not.toContain(CLIENT_SECRET)
		expect([...finished.headers.entries()].join(" ")).not.toContain(CLIENT_SECRET)
		expect(logLines.join("\n")).not.toContain(CLIENT_SECRET)
	})
})

const adminUrl = process.env.TEST_DATABASE_URL ?? ""
const untouchedName = `oidc_untouched_${randomUUID().replaceAll("-", "")}`

const onConnection = async (connectionString: string, statement: string): Promise<void> => {
	const client = new Client({ connectionString })
	await client.connect()
	try {
		await client.query(statement)
	} finally {
		await client.end()
	}
}

describe("signing in against a deployment nobody has bootstrapped yet", () => {
	let untouchedDb: Db
	let untouchedUrl: string
	let untouchedApp: Hono

	beforeAll(async () => {
		await onConnection(adminUrl, `create database "${untouchedName}"`)
		const url = new URL(adminUrl)
		url.pathname = `/${untouchedName}`
		untouchedUrl = url.toString()
		untouchedDb = createDb(untouchedUrl)
		const migrated = await migrateToLatest(untouchedDb)
		if (migrated.error) throw migrated.error
		const mounted = createAuth(untouchedDb, SECRET, BASE_URL, {
			userCreation: "closed",
			disableRateLimit: true,
			trustedOrigins: [ORIGIN],
			oidc: oidcProviderFrom(await env()),
		})
		untouchedApp = new Hono()
		mountDashboardAuth(untouchedApp, mounted, { oidc: true })
	}, STARTUP_TIMEOUT_MS)

	afterAll(async () => {
		await untouchedDb.destroy()
		await onConnection(adminUrl, `drop database "${untouchedName}" with (force)`)
	})

	it("refuses the first stranger to arrive, leaving the owner's bootstrap still able to run", async () => {
		expect(await anyUserExists(untouchedDb)).toBe(false)

		const res = await signInThrough(untouchedApp, {
			subject: `subject-${randomUUID()}`,
			email: `${randomUUID()}@example.com`,
			emailConfirmed: true,
		})

		expect(locationOf(res).searchParams.get("error")).toBe(REGISTRATION_CLOSED_CODE)
		expect(locationOf(res).searchParams.get("error_description")).toBe(REGISTRATION_CLOSED_MESSAGE)
		expect(await untouchedDb.selectFrom("user").select("id").execute()).toEqual([])
		expect(await untouchedDb.selectFrom("session").select("id").execute()).toEqual([])

		const owner = await bootstrapOwner(
			untouchedUrl,
			untouchedDb,
			createAuth(untouchedDb, SECRET, BASE_URL, {
				disableSignUp: false,
				disableRateLimit: true,
				allowOrganizationCreation: true,
			}),
			{
				email: `${randomUUID()}@example.com`,
				password: PASSWORD,
				name: "First Owner",
				organizationName: "Bootstrapped Org",
				organizationSlug: `org-${randomUUID()}`,
			},
		)

		expect(owner.userId.length).toBeGreaterThan(0)
		expect(owner.organizationId.length).toBeGreaterThan(0)
	})
})

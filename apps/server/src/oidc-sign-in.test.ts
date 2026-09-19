import {
	createSign,
	generateKeyPairSync,
	type JsonWebKey,
	type KeyObject,
	randomUUID,
} from "node:crypto"
import { serve } from "@hono/node-server"
import {
	OIDC_PROVIDER_ID,
	REGISTRATION_CLOSED_CODE,
	REGISTRATION_CLOSED_MESSAGE,
	SIGN_IN_PATH,
} from "@open-mcc/contracts"
import { createLogger, generateKeyPair } from "@open-mcc/core"
import { createDb, type Db, migrateToLatest } from "@open-mcc/db"
import { Hono } from "hono"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createAuth } from "./auth"
import { type ServerHandle, startServer } from "./bootstrap"
import { bootstrapOwner } from "./bootstrap-owner"
import type { Env } from "./env"
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
const CLIENT_ID = "open-mcc-manager"
const CLIENT_SECRET = "idp-client-secret-never-leaves-the-server"
const PERSON_NAME = "Signed In Person"
const SIGNING_KEY_ID = "idp-signing-key"
const ID_TOKEN_LIFETIME_SECONDS = 300

type SigningKey = { privateKey: KeyObject; publicJwk: JsonWebKey }

const generateSigningKey = (): SigningKey => {
	const pair = generateKeyPairSync("rsa", { modulusLength: 2048 })
	return {
		privateKey: pair.privateKey,
		publicJwk: {
			...pair.publicKey.export({ format: "jwk" }),
			kid: SIGNING_KEY_ID,
			alg: "RS256",
			use: "sig",
		},
	}
}

const segment = (value: string): string => Buffer.from(value).toString("base64url")

type IdTokenClaims = {
	iss: string
	aud: string
	sub: string
	email: string
	email_verified: boolean
	name: string
	nonce: string
	iat: number
	exp: number
}

const signIdToken = (key: SigningKey, claims: IdTokenClaims): string => {
	const header = JSON.stringify({ alg: "RS256", typ: "JWT", kid: SIGNING_KEY_ID })
	const signed = `${segment(header)}.${segment(JSON.stringify(claims))}`
	const signature = createSign("RSA-SHA256").update(signed).end().sign(key.privateKey)
	return `${signed}.${signature.toString("base64url")}`
}

const published = generateSigningKey()
const unpublished = generateSigningKey()

type Identity = { subject: string; email: string; emailConfirmed: boolean }

let issuer = ""
let identity: Identity = { subject: "", email: "", emailConfirmed: false }
let signsWith: SigningKey = published
let nonceOverride: string | undefined
let tokenRequests: string[] = []
let userInfoReads = 0
let jwksReads = 0
const nonceOfCode = new Map<string, string>()

const provider = new Hono()
provider.get("/.well-known/openid-configuration", (c) =>
	c.json({
		issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: `${issuer}/token`,
		userinfo_endpoint: `${issuer}/userinfo`,
		jwks_uri: `${issuer}/jwks`,
		id_token_signing_alg_values_supported: ["RS256"],
		response_types_supported: ["code"],
		subject_types_supported: ["public"],
	}),
)
provider.get("/jwks", (c) => {
	jwksReads += 1
	return c.json({ keys: [published.publicJwk] })
})
provider.get("/authorize", (c) => {
	const code = randomUUID()
	nonceOfCode.set(code, c.req.query("nonce") ?? "")
	const back = new URL(c.req.query("redirect_uri") ?? "")
	back.searchParams.set("code", code)
	back.searchParams.set("state", c.req.query("state") ?? "")
	return c.redirect(back.toString(), 302)
})
provider.post("/token", async (c) => {
	const body = await c.req.text()
	tokenRequests.push(body)
	const issuedAt = Math.floor(Date.now() / 1000)
	return c.json({
		access_token: "idp-access-token",
		id_token: signIdToken(signsWith, {
			iss: issuer,
			aud: CLIENT_ID,
			sub: identity.subject,
			email: identity.email,
			email_verified: identity.emailConfirmed,
			name: PERSON_NAME,
			nonce: nonceOverride ?? nonceOfCode.get(new URLSearchParams(body).get("code") ?? "") ?? "",
			iat: issuedAt,
			exp: issuedAt + ID_TOKEN_LIFETIME_SECONDS,
		}),
		token_type: "Bearer",
		expires_in: 3600,
	})
})
provider.get("/userinfo", (c) => {
	userInfoReads += 1
	return c.json({
		sub: identity.subject,
		email: identity.email,
		email_verified: identity.emailConfirmed,
		name: PERSON_NAME,
	})
})

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
	OIDC_CLIENT_ID: CLIENT_ID,
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

type Started = { cookie: string; authorizeUrl: URL }

const startSingleSignOn = async (app: Hono, ip: string): Promise<Started> => {
	const res = await app.request("/api/auth/sign-in/social", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, "x-forwarded-for": ip },
		body: JSON.stringify({
			provider: OIDC_PROVIDER_ID,
			callbackURL: `${ORIGIN}/hosts`,
			errorCallbackURL: `${ORIGIN}${SIGN_IN_PATH}`,
		}),
	})
	expect(res.status, await res.clone().text()).toBe(200)
	return {
		authorizeUrl: new URL(authorizeSchema.parse(await res.json()).url),
		cookie: res.headers
			.getSetCookie()
			.map((each) => each.split(";")[0])
			.join("; "),
	}
}

const authorizeAtProvider = async (started: Started): Promise<string> => {
	const res = await fetch(started.authorizeUrl, { redirect: "manual" })
	const back = new URL(res.headers.get("location") ?? "")
	return `${back.pathname}${back.search}`
}

const followCallback = async (
	app: Hono,
	callbackPath: string,
	cookie: string,
	ip: string,
): Promise<Response> =>
	await app.request(callbackPath, {
		method: "GET",
		headers: { Cookie: cookie, "x-forwarded-for": ip },
	})

type Journey = { started: Started; callbackPath: string; ip: string; response: Response }

const signInJourney = async (app: Hono, who: Identity): Promise<Journey> => {
	identity = who
	const ip = forwardedFor()
	const started = await startSingleSignOn(app, ip)
	const callbackPath = await authorizeAtProvider(started)
	return {
		started,
		callbackPath,
		ip,
		response: await followCallback(app, callbackPath, started.cookie, ip),
	}
}

const signInThrough = async (app: Hono, who: Identity): Promise<Response> =>
	(await signInJourney(app, who)).response

const signedBy = async (key: SigningKey, who: Identity): Promise<Response> => {
	signsWith = key
	try {
		return await signInThrough(handle.app, who)
	} finally {
		signsWith = published
	}
}

const boundTo = async (nonce: string, who: Identity): Promise<Response> => {
	nonceOverride = nonce
	try {
		return await signInThrough(handle.app, who)
	} finally {
		nonceOverride = undefined
	}
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

const sessionsOf = async (userId: string) =>
	await db.selectFrom("session").select("id").where("userId", "=", userId).execute()

const providerAccountsOf = async (userId: string) =>
	await db
		.selectFrom("account")
		.select("id")
		.where("userId", "=", userId)
		.where("providerId", "=", OIDC_PROVIDER_ID)
		.execute()

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

	it("reads who arrived from the signed ID token, never from the provider's userinfo endpoint", async () => {
		const invited = await seedMember("operator")
		userInfoReads = 0

		const res = await signInThrough(handle.app, {
			subject: `subject-${randomUUID()}`,
			email: invited.email,
			emailConfirmed: true,
		})

		expect(locationOf(res).toString()).toBe(`${ORIGIN}/hosts`)
		expect(userInfoReads).toBe(0)
		expect(jwksReads).toBeGreaterThan(0)
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
		expect((await providerAccountsOf(invited.userId)).length).toBe(1)
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
		expect(`${location.origin}${location.pathname}`).toBe(`${ORIGIN}${SIGN_IN_PATH}`)
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
		expect(await providerAccountsOf(invited.userId)).toEqual([])
		expect(await sessionsOf(invited.userId)).toEqual([])
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

describe("the provider's ID token", () => {
	it("decides entry by its signature: a key the provider never published is refused, the one it published is admitted", async () => {
		const invited = await seedMember("operator")
		const who = {
			subject: `subject-${randomUUID()}`,
			email: invited.email,
			emailConfirmed: true,
		}

		const refused = await signedBy(unpublished, who)

		expect(refused.status).toBe(302)
		expect(locationOf(refused).searchParams.get("error")).toBe("unable_to_get_user_info")
		expect(refused.headers.getSetCookie().join("; ")).not.toContain("session_token")
		expect(await sessionsOf(invited.userId)).toEqual([])
		expect(await providerAccountsOf(invited.userId)).toEqual([])

		const admitted = await signedBy(published, who)

		expect(locationOf(admitted).toString()).toBe(`${ORIGIN}/hosts`)
		expect((await sessionsOf(invited.userId)).length).toBe(1)
		expect((await providerAccountsOf(invited.userId)).length).toBe(1)
	})

	it("must answer the nonce this deployment sent, so one bound to another is refused", async () => {
		const invited = await seedMember("operator")

		const refused = await boundTo(`nonce-${randomUUID()}`, {
			subject: `subject-${randomUUID()}`,
			email: invited.email,
			emailConfirmed: true,
		})

		expect(refused.status).toBe(302)
		expect(locationOf(refused).searchParams.get("error")).toBe("unable_to_get_user_info")
		expect(refused.headers.getSetCookie().join("; ")).not.toContain("session_token")
		expect(await sessionsOf(invited.userId)).toEqual([])
		expect(await providerAccountsOf(invited.userId)).toEqual([])
	})
})

describe("a callback address opened a second time", () => {
	it("sends an operator who reloads it back to the dashboard's sign-in page", async () => {
		const invited = await seedMember("operator")
		const journey = await signInJourney(handle.app, {
			subject: `subject-${randomUUID()}`,
			email: invited.email,
			emailConfirmed: true,
		})
		expect(locationOf(journey.response).toString()).toBe(`${ORIGIN}/hosts`)

		const reloaded = await followCallback(
			handle.app,
			journey.callbackPath,
			journey.started.cookie,
			journey.ip,
		)

		const location = locationOf(reloaded)
		expect(reloaded.status).toBe(302)
		expect(`${location.origin}${location.pathname}`).toBe(`${ORIGIN}${SIGN_IN_PATH}`)
		expect(reloaded.headers.getSetCookie().join("; ")).not.toContain("session_token")
		expect((await sessionsOf(invited.userId)).length).toBe(1)
	})

	it("sends a visitor who opens it carrying nothing to that same page", async () => {
		const res = await handle.app.request(`/api/auth/callback/${OIDC_PROVIDER_ID}`, {
			method: "GET",
			headers: { "x-forwarded-for": forwardedFor() },
		})

		const location = locationOf(res)
		expect(res.status).toBe(302)
		expect(`${location.origin}${location.pathname}`).toBe(`${ORIGIN}${SIGN_IN_PATH}`)
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
		tokenRequests = []

		const journey = await signInJourney(handle.app, {
			subject: `subject-${randomUUID()}`,
			email: invited.email,
			emailConfirmed: true,
		})

		expect(tokenRequests.join(" ")).toContain(CLIENT_SECRET)
		expect(journey.started.authorizeUrl.toString()).not.toContain(CLIENT_SECRET)
		expect(journey.started.cookie).not.toContain(CLIENT_SECRET)
		expect(await journey.response.clone().text()).not.toContain(CLIENT_SECRET)
		expect([...journey.response.headers.entries()].join(" ")).not.toContain(CLIENT_SECRET)
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
	let untouched: ServerHandle
	let untouchedDb: Db
	let untouchedUrl: string

	beforeAll(async () => {
		await onConnection(adminUrl, `create database "${untouchedName}"`)
		const url = new URL(adminUrl)
		url.pathname = `/${untouchedName}`
		untouchedUrl = url.toString()
		untouchedDb = createDb(untouchedUrl)
		const migrated = await migrateToLatest(untouchedDb)
		if (migrated.error) throw migrated.error
		untouched = await startServer(
			{ ...(await env()), DATABASE_URL: untouchedUrl },
			vi.fn(),
			createLogger({ write: () => undefined }),
		)
	}, STARTUP_TIMEOUT_MS)

	afterAll(async () => {
		untouched.scheduler.stop()
		untouched.healthPoller.stop()
		untouched.heartbeat.stop()
		await untouched.boss.stop({ graceful: false })
		await untouched.lock.release()
		await untouched.db.destroy()
		await untouchedDb.destroy()
		await onConnection(adminUrl, `drop database "${untouchedName}" with (force)`)
	})

	it("refuses the first stranger to arrive, leaving the owner's bootstrap still able to run", async () => {
		expect(await anyUserExists(untouchedDb)).toBe(false)

		const res = await signInThrough(untouched.app, {
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

import { randomUUID } from "node:crypto"
import { createLogger, generateKeyPair } from "@open-mcc/core"
import { createDb, type Db } from "@open-mcc/db"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createAuth } from "./auth"
import { type ServerHandle, startServer } from "./bootstrap"
import type { Env } from "./env"

vi.mock("@open-mcc/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@open-mcc/core")>()
	return {
		...actual,
		startScheduler: () => ({ stop: () => undefined }),
		startHealthPoller: () => ({ stop: () => undefined }),
	}
})

const ORIGIN = "http://localhost:5173"
const SECRET = "a-very-long-test-secret-value-000000"
const BASE_URL = "http://localhost:3000"
const PASSWORD = "correct horse battery staple 1"

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
})

let handle: ServerHandle
let db: Db
let seedAuth: ReturnType<typeof createAuth>

beforeAll(async () => {
	handle = await startServer(await env(), vi.fn(), createLogger({ write: () => undefined }))
	db = createDb(process.env.TEST_DATABASE_URL ?? "")
	seedAuth = createAuth(db, SECRET, BASE_URL, {
		disableSignUp: false,
		disableRateLimit: true,
		allowOrganizationCreation: true,
		userCreation: "trusted",
		trustedOrigins: [ORIGIN],
	})
})

afterAll(async () => {
	handle.scheduler.stop()
	handle.healthPoller.stop()
	handle.heartbeat.stop()
	await handle.boss.stop({ graceful: false })
	await handle.lock.release()
	await handle.db.destroy()
	await db.destroy()
})

let seededOrganizationIds: string[] = []
let seededEmails: string[] = []

afterEach(async () => {
	const organizationIds = seededOrganizationIds
	const emails = seededEmails
	seededOrganizationIds = []
	seededEmails = []
	if (organizationIds.length > 0) {
		await db.deleteFrom("auditEvent").where("organizationId", "in", organizationIds).execute()
		await db.deleteFrom("invitation").where("organizationId", "in", organizationIds).execute()
		await db.deleteFrom("member").where("organizationId", "in", organizationIds).execute()
		await db.deleteFrom("organization").where("id", "in", organizationIds).execute()
	}
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

const seededEmail = (): string => {
	const email = `${randomUUID()}@example.com`
	seededEmails.push(email)
	return email
}

let lastClientAddress = 0

const forwardedFor = (): string => {
	lastClientAddress += 1
	return `203.0.113.${lastClientAddress}`
}

type Actor = { email: string; cookie: string; ip: string }

const send = async (
	path: string,
	actor: Actor,
	init: { method: "GET" | "POST"; body?: string },
): Promise<Response> =>
	await handle.app.request(path, {
		method: init.method,
		headers: {
			"content-type": "application/json",
			Origin: ORIGIN,
			Cookie: actor.cookie,
			"x-forwarded-for": actor.ip,
		},
		...(init.body === undefined ? {} : { body: init.body }),
	})

const signIn = async (email: string): Promise<Actor> => {
	const ip = forwardedFor()
	const res = await handle.app.request("/api/auth/sign-in/email", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, "x-forwarded-for": ip },
		body: JSON.stringify({ email, password: PASSWORD }),
	})
	expect(res.status, await res.clone().text()).toBe(200)
	const cookie = res.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ")
	return { email, cookie, ip }
}

const signUp = async (name: string): Promise<{ email: string; userId: string }> => {
	const email = seededEmail()
	const created = await seedAuth.api.signUpEmail({ body: { email, password: PASSWORD, name } })
	return { email, userId: created.user.id }
}

const seedOrganization = async () => {
	const owner = await signUp("Route Owner")
	const organization = await seedAuth.api.createOrganization({
		body: { name: "Route Org", slug: `org-${randomUUID()}`, userId: owner.userId },
	})
	const orgId = organization?.id ?? ""
	seededOrganizationIds.push(orgId)
	const viewer = await signUp("Route Viewer")
	await db
		.insertInto("member")
		.values({ id: randomUUID(), organizationId: orgId, userId: viewer.userId, role: "viewer" })
		.execute()

	const ownerActor = await signIn(owner.email)
	const inviteeEmail = seededEmail()
	const invited = await send("/trpc/member.invite", ownerActor, {
		method: "POST",
		body: JSON.stringify({ email: inviteeEmail, role: "owner" }),
	})
	expect(invited.status, await invited.clone().text()).toBe(200)
	const invitation = await db
		.selectFrom("invitation")
		.select("id")
		.where("organizationId", "=", orgId)
		.where("status", "=", "pending")
		.executeTakeFirstOrThrow()

	return {
		orgId,
		owner: ownerActor,
		viewer: await signIn(viewer.email),
		invitationId: invitation.id,
	}
}

const sessionSchema = z.object({ user: z.object({ email: z.string() }) }).nullable()
const organizationsSchema = z.array(z.object({ id: z.string() }))
const roleSchema = z.object({ result: z.object({ data: z.object({ role: z.string() }) }) })

describe("the better-auth routes the running server answers", () => {
	it("★ registers exactly the five dashboard routes under /api/auth, and nothing else", () => {
		const mounted = handle.app.routes
			.filter((route) => route.path.startsWith("/api/auth"))
			.map((route) => `${route.method} ${route.path}`)
			.sort()

		expect(mounted).toEqual([
			"GET /api/auth/get-session",
			"GET /api/auth/organization/list",
			"POST /api/auth/organization/set-active",
			"POST /api/auth/sign-in/email",
			"POST /api/auth/sign-out",
		])
	})

	it.each(["list-invitations", "get-full-organization"])(
		"★ refuses a viewer's organization/%s, so no pending invitation id leaves the server",
		async (route) => {
			const { orgId, viewer, invitationId } = await seedOrganization()

			const res = await send(`/api/auth/organization/${route}?organizationId=${orgId}`, viewer, {
				method: "GET",
			})
			const text = await res.text()

			expect(res.status, text).toBe(404)
			expect(text).not.toContain(invitationId)
		},
	)

	it.each([
		{ category: "creating an account", method: "POST", path: "/api/auth/sign-up/email" },
		{
			category: "managing members",
			method: "POST",
			path: "/api/auth/organization/update-member-role",
		},
		{
			category: "changing the organization",
			method: "POST",
			path: "/api/auth/organization/update",
		},
		{ category: "listing sessions", method: "GET", path: "/api/auth/list-sessions" },
	] as const)("★ answers 404 to an owner $category", async ({ method, path }) => {
		const { orgId, owner } = await seedOrganization()

		const res = await send(path, owner, {
			method,
			...(method === "POST"
				? {
						body: JSON.stringify({
							email: `${randomUUID()}@example.com`,
							password: PASSWORD,
							name: "Nobody",
							organizationId: orgId,
							memberId: randomUUID(),
							role: "owner",
							data: { name: "Renamed" },
						}),
					}
				: {}),
		})

		expect(res.status, await res.text()).toBe(404)
	})

	it("still signs a member in, reads the session, lists and activates the organization, and signs out", async () => {
		const { orgId, viewer } = await seedOrganization()

		const session = await send("/api/auth/get-session", viewer, { method: "GET" })
		expect(session.status).toBe(200)
		expect(sessionSchema.parse(await session.json())?.user.email).toBe(viewer.email)

		const organizations = await send("/api/auth/organization/list", viewer, { method: "GET" })
		expect(organizations.status).toBe(200)
		expect(organizationsSchema.parse(await organizations.json()).map((each) => each.id)).toEqual([
			orgId,
		])

		const activated = await send("/api/auth/organization/set-active", viewer, {
			method: "POST",
			body: JSON.stringify({ organizationId: orgId }),
		})
		expect(activated.status, await activated.clone().text()).toBe(200)

		const signedOut = await send("/api/auth/sign-out", viewer, { method: "POST", body: "{}" })
		expect(signedOut.status, await signedOut.clone().text()).toBe(200)

		const after = await send("/api/auth/get-session", viewer, { method: "GET" })
		expect(sessionSchema.parse(await after.json())).toBeNull()
	})

	it("still reaches better-auth in-process for the session, an invitation and its acceptance", async () => {
		const { orgId, viewer, invitationId } = await seedOrganization()

		const me = await send("/trpc/member.me", viewer, { method: "GET" })
		expect(me.status).toBe(200)
		expect(roleSchema.parse(await me.json()).result.data.role).toBe("viewer")

		const accepted = await handle.app.request("/trpc/member.acceptInvitation", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ invitationId, name: "Invitee", password: PASSWORD }),
		})
		expect(accepted.status, await accepted.clone().text()).toBe(200)

		const invitation = await db
			.selectFrom("invitation")
			.select("status")
			.where("id", "=", invitationId)
			.executeTakeFirstOrThrow()
		expect(invitation.status).toBe("accepted")
		const members = await db
			.selectFrom("member")
			.select("role")
			.where("organizationId", "=", orgId)
			.execute()
		expect(members.map((each) => each.role).sort()).toEqual(["owner", "owner", "viewer"])
	})
})

import { randomUUID } from "node:crypto"
import { trpcServer } from "@hono/trpc-server"
import {
	createHostController,
	createHostControllerTransaction,
	createHostRepository,
	createSecretStore,
	createSshKeyController,
	createSshKeyControllerTransaction,
	createSshKeyRepository,
	generateKeyPair,
	generateSshKeyPair,
} from "@open-mcc/core"
import { createDb, type Db } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { Hono } from "hono"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { createAuth } from "./auth"
import { createRequestContext } from "./create-context"
import { memberControllerFor } from "./members"
import { appRouter } from "./routers/index"
import { requireSameOrigin, strictCors } from "./security/cors"
import { securityHeaders } from "./security/headers"
import { createTestDestinationController } from "./test/destination-controller"
import { createTestInstanceController } from "./test/instance-controller"
import { createTestSelfHostController } from "./test/self-host-controller"
import { createTestStatusController } from "./test/status-controller"

const ORIGIN = "http://localhost:5173"

let db: Db
let app: Hono

beforeAll(async () => {
	const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? ""
	db = createDb(testDatabaseUrl)
	const auth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000", {
		trustedOrigins: [ORIGIN],
		disableSignUp: false,
		userCreation: "trusted",
		disableRateLimit: true,
		allowOrganizationCreation: true,
	})
	const secrets = await createSecretStore(await generateKeyPair("k1"))

	const hosts = createHostRepository(db)
	const sshKeys = createSshKeyRepository(db)
	const hostController = createHostController({
		hosts,
		sshKeys,
		secrets,
		probeHostKey: async () => Buffer.alloc(0),
		createTransport: () => createFakeTransport(),
		evictHost: () => undefined,
		instanceIdsOnHost: async () => [],
		now: () => new Date(),
		withTransaction: createHostControllerTransaction(db, async () => null),
	})
	const sshKeyController = createSshKeyController({
		sshKeys,
		secrets,
		generateKeyPair: generateSshKeyPair,
		withTransaction: createSshKeyControllerTransaction(db),
	})

	app = new Hono()
	app.use("*", securityHeaders())
	app.use("*", strictCors([ORIGIN]))
	app.use("*", requireSameOrigin([ORIGIN]))
	app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
	app.use(
		"/trpc/*",
		trpcServer({
			router: appRouter,
			createContext: createRequestContext({
				auth,
				signupAuth: auth,
				db,
				hostController,
				processIdentities: {
					announce: async () => undefined,
					heartbeat: async () => undefined,
					find: async () => undefined,
				},
				build: { version: "0.0.0-test", commit: "testsha" },
				schemaVersion: "test",
				instanceController: await createTestInstanceController(db),
				statusController: createTestStatusController(db),
				destinationController: createTestDestinationController(db, secrets),
				sshKeyController,
				selfHostController: createTestSelfHostController(db),
				memberController: memberControllerFor(db, auth, () => undefined),
			}),
		}),
	)
})

afterAll(async () => {
	await db.destroy()
})

const orgResponseSchema = z.object({ id: z.string() })
const inviteResponseSchema = z.object({
	result: z.object({ data: z.object({ id: z.string(), expiresAt: z.string().datetime() }) }),
})
const userIdOf = async (email: string): Promise<string> =>
	(await db.selectFrom("user").select("id").where("email", "=", email).executeTakeFirstOrThrow()).id

const extractCookie = (res: Response): string => {
	const cookies = res.headers.getSetCookie()
	return cookies.map((cookie) => cookie.split(";")[0]).join("; ")
}

let seededOrganizationIds: string[] = []
let seededEmails: string[] = []

const seededEmail = (): string => {
	const email = `${randomUUID()}@example.com`
	seededEmails.push(email)
	return email
}

const signUpAndActivate = async (
	name: string,
): Promise<{ email: string; cookie: string; orgId: string }> => {
	const email = seededEmail()
	const signUpRes = await app.request("/api/auth/sign-up/email", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({ email, password: "correct horse battery staple 1", name }),
	})
	expect(signUpRes.status).toBe(200)
	const cookie = extractCookie(signUpRes)

	const createOrgRes = await app.request("/api/auth/organization/create", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ name: "Invitation Org", slug: `org-${randomUUID()}` }),
	})
	expect(createOrgRes.status).toBe(200)
	const org = orgResponseSchema.parse(await createOrgRes.json())
	seededOrganizationIds.push(org.id)

	const setActiveRes = await app.request("/api/auth/organization/set-active", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ organizationId: org.id }),
	})
	expect(setActiveRes.status).toBe(200)

	return { email, cookie, orgId: org.id }
}

const deleteSeededRows = async (organizationIds: string[], emails: string[]): Promise<void> => {
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
}

afterEach(async () => {
	const organizationIds = seededOrganizationIds
	const emails = seededEmails
	seededOrganizationIds = []
	seededEmails = []
	await deleteSeededRows(organizationIds, emails)
})

describe("member invitations", () => {
	it("rejects an invitation attempt from a member without member.manage", async () => {
		const owner = await signUpAndActivate("Owner")

		const viewerEmail = seededEmail()
		const viewerSignUpRes = await app.request("/api/auth/sign-up/email", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({
				email: viewerEmail,
				password: "correct horse battery staple 2",
				name: "Viewer",
			}),
		})
		expect(viewerSignUpRes.status).toBe(200)
		const viewerCookie = extractCookie(viewerSignUpRes)
		const viewerUser = await db
			.selectFrom("user")
			.select("id")
			.where("email", "=", viewerEmail)
			.executeTakeFirstOrThrow()
		await db
			.insertInto("member")
			.values({ id: randomUUID(), organizationId: owner.orgId, userId: viewerUser.id })
			.execute()
		const setActiveRes = await app.request("/api/auth/organization/set-active", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: viewerCookie },
			body: JSON.stringify({ organizationId: owner.orgId }),
		})
		expect(setActiveRes.status).toBe(200)

		const inviteRes = await app.request("/trpc/member.invite", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: viewerCookie },
			body: JSON.stringify({ email: seededEmail(), role: "operator" }),
		})
		const body = await inviteRes.text()
		expect(inviteRes.status, body).toBe(403)
		expect(body.toLowerCase()).not.toContain("requires member.manage")

		const invitations = await db
			.selectFrom("invitation")
			.select("id")
			.where("organizationId", "=", owner.orgId)
			.execute()
		expect(invitations).toHaveLength(0)
	})

	it("lets an owner invite an operator who accepts and lands in the org as an operator", async () => {
		const owner = await signUpAndActivate("Owner")
		const inviteeEmail = seededEmail()

		const inviteRes = await app.request("/trpc/member.invite", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: owner.cookie },
			body: JSON.stringify({ email: inviteeEmail, role: "operator" }),
		})
		const inviteBody = await inviteRes.text()
		expect(inviteRes.status, inviteBody).toBe(200)
		const invitation = inviteResponseSchema.parse(JSON.parse(inviteBody)).result.data

		const inviteAudit = await db
			.selectFrom("auditEvent")
			.select(["actorLabel", "detail"])
			.where("subjectId", "=", invitation.id)
			.where("action", "=", "member.invite")
			.executeTakeFirst()
		expect(inviteAudit?.actorLabel).toBe(owner.email)
		expect(inviteAudit?.detail).toMatchObject({ email: inviteeEmail, role: "operator" })

		const acceptRes = await app.request("/trpc/member.acceptInvitation", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({
				invitationId: invitation.id,
				password: "correct horse battery staple 3",
				name: "Invited Operator",
			}),
		})
		const acceptBody = await acceptRes.text()
		expect(acceptRes.status, acceptBody).toBe(200)
		const accepted = { userId: await userIdOf(inviteeEmail) }

		const memberRow = await db
			.selectFrom("member")
			.select(["id", "role"])
			.where("organizationId", "=", owner.orgId)
			.where("userId", "=", accepted.userId)
			.executeTakeFirst()
		expect(memberRow?.role).toBe("operator")

		const inviteeMembers = await db
			.selectFrom("member")
			.select("id")
			.where("userId", "=", accepted.userId)
			.execute()
		expect(inviteeMembers).toHaveLength(1)

		const signInRes = await app.request("/api/auth/sign-in/email", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({
				email: inviteeEmail,
				password: "correct horse battery staple 3",
			}),
		})
		const signInBody = await signInRes.text()
		expect(signInRes.status, signInBody).toBe(200)

		const acceptAudit = await db
			.selectFrom("auditEvent")
			.select(["actorLabel", "actorId", "detail"])
			.where("subjectId", "=", memberRow?.id ?? "")
			.where("action", "=", "member.accept")
			.executeTakeFirst()
		expect(acceptAudit?.actorLabel).toBe(inviteeEmail)
		expect(acceptAudit?.actorId).toBe(memberRow?.id)
		expect(acceptAudit?.detail).toMatchObject({ invitationId: invitation.id, role: "operator" })
	})

	it("gives an invited owner the owner role, the only succession path a deployment has", async () => {
		const owner = await signUpAndActivate("Owner")
		const successorEmail = seededEmail()
		const successorPassword = "correct horse battery staple 5"

		const inviteRes = await app.request("/trpc/member.invite", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: owner.cookie },
			body: JSON.stringify({ email: successorEmail, role: "owner" }),
		})
		const inviteBody = await inviteRes.text()
		expect(inviteRes.status, inviteBody).toBe(200)
		const invitation = inviteResponseSchema.parse(JSON.parse(inviteBody)).result.data

		const acceptRes = await app.request("/trpc/member.acceptInvitation", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({
				invitationId: invitation.id,
				password: successorPassword,
				name: "Invited Owner",
			}),
		})
		const acceptBody = await acceptRes.text()
		expect(acceptRes.status, acceptBody).toBe(200)
		const accepted = { userId: await userIdOf(successorEmail) }

		const memberRow = await db
			.selectFrom("member")
			.select("role")
			.where("organizationId", "=", owner.orgId)
			.where("userId", "=", accepted.userId)
			.executeTakeFirst()
		expect(memberRow?.role).toBe("owner")

		const signInRes = await app.request("/api/auth/sign-in/email", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ email: successorEmail, password: successorPassword }),
		})
		expect(signInRes.status).toBe(200)
		const successorCookie = extractCookie(signInRes)
		const setActiveRes = await app.request("/api/auth/organization/set-active", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: successorCookie },
			body: JSON.stringify({ organizationId: owner.orgId }),
		})
		expect(setActiveRes.status).toBe(200)

		const successorInviteRes = await app.request("/trpc/member.invite", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Origin: ORIGIN,
				Cookie: extractCookie(setActiveRes) || successorCookie,
			},
			body: JSON.stringify({ email: seededEmail(), role: "viewer" }),
		})
		const successorInviteBody = await successorInviteRes.text()
		expect(successorInviteRes.status, successorInviteBody).toBe(200)
	})
})

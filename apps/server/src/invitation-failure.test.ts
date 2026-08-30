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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { type Auth, createAuth } from "./auth"
import { createRequestContext } from "./create-context"
import { appRouter } from "./routers/index"
import { requireSameOrigin, strictCors } from "./security/cors"
import { securityHeaders } from "./security/headers"

const ORIGIN = "http://localhost:5173"
const OWNER_PASSWORD = "correct horse battery staple 1"
const INVITEE_PASSWORD = "correct horse battery staple 2"

let db: Db
let app: Hono
let auth: Auth

beforeAll(async () => {
	const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? ""
	db = createDb(testDatabaseUrl)
	auth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000", {
		trustedOrigins: [ORIGIN],
		disableSignUp: false,
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
		instancesRoot: "/srv/open-mcc",
		withTransaction: createHostControllerTransaction(db),
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
				sshKeyController,
			}),
		}),
	)
})

afterAll(async () => {
	await db.destroy()
})

const orgResponseSchema = z.object({ id: z.string() })
const inviteResponseSchema = z.object({ result: z.object({ data: z.object({ id: z.string() }) }) })
const errorResponseSchema = z.object({
	error: z.object({ data: z.object({ errorCode: z.string().optional() }) }),
})

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

const signUpAndActivate = async (): Promise<{ email: string; cookie: string; orgId: string }> => {
	const email = seededEmail()
	const signUpRes = await app.request("/api/auth/sign-up/email", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({ email, password: OWNER_PASSWORD, name: "Owner" }),
	})
	expect(signUpRes.status).toBe(200)
	const cookie = extractCookie(signUpRes)

	const createOrgRes = await app.request("/api/auth/organization/create", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ name: "Invitation Failure Org", slug: `org-${randomUUID()}` }),
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

const inviteOperator = async (cookie: string, email: string): Promise<string> => {
	const inviteRes = await app.request("/trpc/member.invite", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ email, role: "operator" }),
	})
	const body = await inviteRes.text()
	expect(inviteRes.status, body).toBe(200)
	return inviteResponseSchema.parse(JSON.parse(body)).result.data.id
}

const accept = async (invitationId: string, password: string): Promise<Response> =>
	app.request("/trpc/member.acceptInvitation", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({ invitationId, password, name: "Invited Operator" }),
	})

const expectInvitationNotFound = async (res: Response): Promise<void> => {
	const body = await res.text()
	expect(res.status, body).toBe(400)
	expect(errorResponseSchema.parse(JSON.parse(body)).error.data.errorCode).toBe(
		"INVITATION_NOT_FOUND",
	)
}

const memberIdsFor = async (organizationId: string): Promise<string[]> => {
	const rows = await db
		.selectFrom("member")
		.select("id")
		.where("organizationId", "=", organizationId)
		.execute()
	return rows.map((row) => row.id)
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
	vi.restoreAllMocks()
	const organizationIds = seededOrganizationIds
	const emails = seededEmails
	seededOrganizationIds = []
	seededEmails = []
	await deleteSeededRows(organizationIds, emails)
})

describe("member.acceptInvitation failure modes", () => {
	it("rejects a replayed invitation id once the invitation has been accepted, adding no second member", async () => {
		const owner = await signUpAndActivate()
		const inviteeEmail = seededEmail()
		const invitationId = await inviteOperator(owner.cookie, inviteeEmail)

		const firstBody = await (await accept(invitationId, INVITEE_PASSWORD)).text()
		expect(firstBody).toContain("operator")
		const afterFirst = await memberIdsFor(owner.orgId)
		expect(afterFirst).toHaveLength(2)

		await expectInvitationNotFound(await accept(invitationId, INVITEE_PASSWORD))

		expect(await memberIdsFor(owner.orgId)).toEqual(afterFirst)
		const invitationRow = await db
			.selectFrom("invitation")
			.select("status")
			.where("id", "=", invitationId)
			.executeTakeFirst()
		expect(invitationRow?.status).toBe("accepted")
	})

	it("rejects an invitation whose expiry has passed, creating neither a user nor a member", async () => {
		const owner = await signUpAndActivate()
		const inviteeEmail = seededEmail()
		const invitationId = await inviteOperator(owner.cookie, inviteeEmail)
		await db
			.updateTable("invitation")
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where("id", "=", invitationId)
			.execute()

		await expectInvitationNotFound(await accept(invitationId, INVITEE_PASSWORD))

		expect(await memberIdsFor(owner.orgId)).toHaveLength(1)
		const invitee = await db
			.selectFrom("user")
			.select("id")
			.where("email", "=", inviteeEmail)
			.executeTakeFirst()
		expect(invitee).toBeUndefined()
	})

	it("rejects an invitation carrying no role rather than seeding a member the request context cannot resolve", async () => {
		const owner = await signUpAndActivate()
		const inviteeEmail = seededEmail()
		const invitationId = await inviteOperator(owner.cookie, inviteeEmail)
		await db.updateTable("invitation").set({ role: null }).where("id", "=", invitationId).execute()

		await expectInvitationNotFound(await accept(invitationId, INVITEE_PASSWORD))

		expect(await memberIdsFor(owner.orgId)).toHaveLength(1)
		const invitee = await db
			.selectFrom("user")
			.select("id")
			.where("email", "=", inviteeEmail)
			.executeTakeFirst()
		expect(invitee).toBeUndefined()
	})

	it("rejects an unknown invitation id without disclosing whether it ever existed", async () => {
		await expectInvitationNotFound(await accept(randomUUID(), INVITEE_PASSWORD))
	})

	it("fences a second accept that read the invitation while it was still pending, leaving one member", async () => {
		const owner = await signUpAndActivate()
		const inviteeEmail = seededEmail()
		const replayEmail = seededEmail()
		const invitationId = await inviteOperator(owner.cookie, inviteeEmail)

		const realSignUpEmail = auth.api.signUpEmail
		let arrived = 0
		let releaseBoth: () => void = () => {}
		const bothArrived = new Promise<void>((resolve) => {
			releaseBoth = resolve
		})
		vi.spyOn(auth.api, "signUpEmail").mockImplementation(async (params) => {
			if (!params) throw new Error("signUpEmail was called without arguments")
			arrived += 1
			const position = arrived
			if (arrived === 2) releaseBoth()
			await bothArrived
			return realSignUpEmail({
				...params,
				body: { ...params.body, email: position === 1 ? inviteeEmail : replayEmail },
			})
		})

		const responses = await Promise.all([
			accept(invitationId, INVITEE_PASSWORD),
			accept(invitationId, INVITEE_PASSWORD),
		])
		const statuses = responses.map((res) => res.status).sort((a, b) => a - b)
		expect(statuses).toEqual([200, 400])
		const rejected = responses.find((res) => res.status !== 200)
		expect(rejected).toBeDefined()
		if (rejected) await expectInvitationNotFound(rejected)

		expect(await memberIdsFor(owner.orgId)).toHaveLength(2)
		const bothUsers = await db
			.selectFrom("user")
			.select("id")
			.where("email", "in", [inviteeEmail, replayEmail])
			.execute()
		expect(bothUsers).toHaveLength(2)
		const membersForBothUsers = await db
			.selectFrom("member")
			.select("userId")
			.where(
				"userId",
				"in",
				bothUsers.map((row) => row.id),
			)
			.execute()
		expect(membersForBothUsers).toHaveLength(1)

		const invitationRow = await db
			.selectFrom("invitation")
			.select("status")
			.where("id", "=", invitationId)
			.executeTakeFirst()
		expect(invitationRow?.status).toBe("accepted")
	})
})

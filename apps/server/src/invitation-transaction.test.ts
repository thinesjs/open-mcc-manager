import { randomUUID } from "node:crypto"
import { trpcServer } from "@hono/trpc-server"
import { createDb, type Db } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { Hono } from "hono"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createTestInstanceController } from "./test/instance-controller"

const failNextAuditRecord = { current: false }

vi.mock("@open-mcc/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@open-mcc/core")>()
	return {
		...actual,
		createAuditRepository: (executor: Parameters<typeof actual.createAuditRepository>[0]) => {
			const real = actual.createAuditRepository(executor)
			return {
				...real,
				record: async (...args: Parameters<typeof real.record>) => {
					if (failNextAuditRecord.current) {
						failNextAuditRecord.current = false
						throw new Error("simulated audit failure")
					}
					return real.record(...args)
				},
			}
		},
	}
})

const {
	createHostController,
	createHostControllerTransaction,
	createHostRepository,
	createSecretStore,
	createSshKeyController,
	createSshKeyControllerTransaction,
	createSshKeyRepository,
	generateKeyPair,
	generateSshKeyPair,
} = await import("@open-mcc/core")
const { createAuth } = await import("./auth")
const { createRequestContext } = await import("./create-context")
const { appRouter } = await import("./routers/index")
const { requireSameOrigin, strictCors } = await import("./security/cors")
const { securityHeaders } = await import("./security/headers")

const ORIGIN = "http://localhost:5173"

let db: Db
let app: Hono

beforeAll(async () => {
	const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? ""
	db = createDb(testDatabaseUrl)
	const auth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000", {
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
		instanceIdsOnHost: vi.fn(async () => []),
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
		body: JSON.stringify({ name: "Transaction Org", slug: `org-${randomUUID()}` }),
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
	failNextAuditRecord.current = false
	const organizationIds = seededOrganizationIds
	const emails = seededEmails
	seededOrganizationIds = []
	seededEmails = []
	await deleteSeededRows(organizationIds, emails)
})

describe("member.acceptInvitation transaction", () => {
	it(
		"rolls back the member insert and the invitation update when a later step in the " +
			"transaction fails, leaving the invitation pending and no member row",
		async () => {
			const owner = await signUpAndActivate("Owner")
			const inviteeEmail = seededEmail()

			const inviteRes = await app.request("/trpc/member.invite", {
				method: "POST",
				headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: owner.cookie },
				body: JSON.stringify({ email: inviteeEmail, role: "operator" }),
			})
			expect(inviteRes.status).toBe(200)
			const invitation = inviteResponseSchema.parse(await inviteRes.json()).result.data

			failNextAuditRecord.current = true
			const acceptRes = await app.request("/trpc/member.acceptInvitation", {
				method: "POST",
				headers: { "content-type": "application/json", Origin: ORIGIN },
				body: JSON.stringify({
					invitationId: invitation.id,
					password: "correct horse battery staple 2",
					name: "Invited Operator",
				}),
			})
			expect(acceptRes.status).toBe(500)
			expect(failNextAuditRecord.current).toBe(false)

			const invitationRow = await db
				.selectFrom("invitation")
				.select("status")
				.where("id", "=", invitation.id)
				.executeTakeFirst()
			expect(invitationRow?.status).toBe("pending")

			const memberRows = await db
				.selectFrom("member")
				.select("id")
				.where("organizationId", "=", owner.orgId)
				.execute()
			expect(memberRows).toHaveLength(1)
			expect(memberRows[0]?.id).not.toBeUndefined()

			const orphanedUser = await db
				.selectFrom("user")
				.select("id")
				.where("email", "=", inviteeEmail)
				.executeTakeFirst()
			expect(orphanedUser).toBeDefined()
			const orphanedMember = await db
				.selectFrom("member")
				.select("id")
				.where("userId", "=", orphanedUser?.id ?? "")
				.executeTakeFirst()
			expect(orphanedMember).toBeUndefined()

			const signInRes = await app.request("/api/auth/sign-in/email", {
				method: "POST",
				headers: { "content-type": "application/json", Origin: ORIGIN },
				body: JSON.stringify({
					email: inviteeEmail,
					password: "correct horse battery staple 2",
				}),
			})
			expect(signInRes.status).toBe(200)
			const orphanCookie = extractCookie(signInRes)

			const setActiveRes = await app.request("/api/auth/organization/set-active", {
				method: "POST",
				headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: orphanCookie },
				body: JSON.stringify({ organizationId: owner.orgId }),
			})
			expect(setActiveRes.status).toBe(403)

			const hostListRes = await app.request("/trpc/host.list", {
				method: "GET",
				headers: { Origin: ORIGIN, Cookie: orphanCookie },
			})
			expect(hostListRes.status).toBe(401)
		},
	)

	it("resolveActor rejects a session whose active organization has no member row for this user", async () => {
		const owner = await signUpAndActivate("Owner")
		const bystander = await signUpAndActivate("Bystander")
		const bystanderUser = await db
			.selectFrom("user")
			.select("id")
			.where("email", "=", bystander.email)
			.executeTakeFirstOrThrow()

		await db
			.updateTable("session")
			.set({ activeOrganizationId: owner.orgId })
			.where("userId", "=", bystanderUser.id)
			.execute()

		const hostListRes = await app.request("/trpc/host.list", {
			method: "GET",
			headers: { Origin: ORIGIN, Cookie: bystander.cookie },
		})
		expect(hostListRes.status).toBe(401)
	})
})

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
import { appRouter } from "./routers/index"
import { requireSameOrigin, strictCors } from "./security/cors"
import { securityHeaders } from "./security/headers"
import { createTestDestinationController } from "./test/destination-controller"
import { createTestInstanceController } from "./test/instance-controller"
import { createTestStatusController } from "./test/status-controller"

const ORIGIN = "http://localhost:5173"
const ORIGINAL_FINGERPRINT = "SHA256:originalIJKLMNOPQRSTUVWXYZabcdefghijklmnopq"
const NEW_FINGERPRINT = "SHA256:newvalueIJKLMNOPQRSTUVWXYZabcdefghijklmnopq"

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
		probeHostKey: async () => {
			throw new Error("probeHostKey should not be called by retrustHostKey")
		},
		createTransport: () => createFakeTransport(),
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
			}),
		}),
	)
})

afterAll(async () => {
	await db.destroy()
})

const orgResponseSchema = z.object({ id: z.string() })
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

const deleteSeededRows = async (organizationIds: string[], emails: string[]): Promise<void> => {
	if (organizationIds.length > 0) {
		await db.deleteFrom("auditEvent").where("organizationId", "in", organizationIds).execute()
		await db.deleteFrom("host").where("organizationId", "in", organizationIds).execute()
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

const signUpAndActivate = async (): Promise<{ email: string; cookie: string; orgId: string }> => {
	const email = seededEmail()
	const signUpRes = await app.request("/api/auth/sign-up/email", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			email,
			password: "correct horse battery staple 1",
			name: "Retrust Test",
		}),
	})
	expect(signUpRes.status).toBe(200)
	const cookie = extractCookie(signUpRes)

	const createOrgRes = await app.request("/api/auth/organization/create", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ name: "Retrust Org", slug: `org-${randomUUID()}` }),
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

const seedTrustedHost = async (orgId: string, ownerMemberId: string): Promise<string> => {
	const hostId = randomUUID()
	await db
		.insertInto("host")
		.values({
			id: hostId,
			organizationId: orgId,
			name: `vps-${hostId}`,
			hostname: "10.0.0.42",
			hostKeyFingerprint: ORIGINAL_FINGERPRINT,
			hostKeyAlgorithm: "ssh-ed25519",
			hostKeyTrustedBy: ownerMemberId,
			hostKeyTrustedByLabel: "seed@example.com",
			hostKeyTrustedAt: new Date(),
		})
		.execute()
	return hostId
}

const ownerMemberId = async (orgId: string, email: string): Promise<string> => {
	const row = await db
		.selectFrom("member")
		.innerJoin("user", "user.id", "member.userId")
		.select("member.id")
		.where("member.organizationId", "=", orgId)
		.where("user.email", "=", email)
		.executeTakeFirstOrThrow()
	return row.id
}

describe("host.retrustHostKey", () => {
	it("updates the trust tuple from an out-of-band fingerprint and audits the actor", async () => {
		const { email, cookie, orgId } = await signUpAndActivate()
		const memberId = await ownerMemberId(orgId, email)
		const hostId = await seedTrustedHost(orgId, memberId)

		const res = await app.request("/trpc/host.retrustHostKey", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({
				hostId,
				hostKeyFingerprint: NEW_FINGERPRINT,
				hostKeyAlgorithm: "ssh-ed25519",
			}),
		})
		const body = await res.text()
		expect(res.status, body).toBe(200)

		const row = await db
			.selectFrom("host")
			.select(["hostKeyFingerprint", "hostKeyTrustedByLabel"])
			.where("id", "=", hostId)
			.executeTakeFirst()
		expect(row?.hostKeyFingerprint).toBe(NEW_FINGERPRINT)
		expect(row?.hostKeyTrustedByLabel).toBe(email)

		const audit = await db
			.selectFrom("auditEvent")
			.select(["actorLabel", "action"])
			.where("subjectId", "=", hostId)
			.where("action", "=", "host.retrust")
			.executeTakeFirst()
		expect(audit?.actorLabel).toBe(email)
	})

	it("rejects a retrust while provisioning is in progress with a distinct code, and leaves the fingerprint unchanged, without leaking any fingerprint", async () => {
		const { email, cookie, orgId } = await signUpAndActivate()
		const memberId = await ownerMemberId(orgId, email)
		const hostId = await seedTrustedHost(orgId, memberId)

		await db
			.updateTable("host")
			.set({
				status: "provisioning",
				provisioningAttemptId: randomUUID(),
				provisioningClaimedAt: new Date(),
			})
			.where("id", "=", hostId)
			.execute()

		const res = await app.request("/trpc/host.retrustHostKey", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({
				hostId,
				hostKeyFingerprint: NEW_FINGERPRINT,
				hostKeyAlgorithm: "ssh-ed25519",
			}),
		})
		const body = await res.text()
		expect(res.status, body).toBe(409)
		expect(body).not.toContain(ORIGINAL_FINGERPRINT)
		expect(body).not.toContain(NEW_FINGERPRINT)
		expect(body).not.toContain("SHA256:")

		const parsed = errorResponseSchema.parse(JSON.parse(body))
		expect(parsed.error.data.errorCode).toBe("HOST_PROVISIONING_IN_PROGRESS")

		const row = await db
			.selectFrom("host")
			.select(["hostKeyFingerprint"])
			.where("id", "=", hostId)
			.executeTakeFirst()
		expect(row?.hostKeyFingerprint).toBe(ORIGINAL_FINGERPRINT)
	})

	it("rejects a viewer's retrust attempt without touching the stored fingerprint, and leaks nothing", async () => {
		const owner = await signUpAndActivate()
		const ownerId = await ownerMemberId(owner.orgId, owner.email)
		const hostId = await seedTrustedHost(owner.orgId, ownerId)

		const viewerEmail = seededEmail()
		const viewerSignUpRes = await app.request("/api/auth/sign-up/email", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({
				email: viewerEmail,
				password: "correct horse battery staple 2",
				name: "Viewer Test",
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

		const res = await app.request("/trpc/host.retrustHostKey", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: viewerCookie },
			body: JSON.stringify({
				hostId,
				hostKeyFingerprint: NEW_FINGERPRINT,
				hostKeyAlgorithm: "ssh-ed25519",
			}),
		})
		const body = await res.text()
		expect(res.status, body).toBe(403)
		expect(body).not.toContain(ORIGINAL_FINGERPRINT)
		expect(body).not.toContain(NEW_FINGERPRINT)
		expect(body).not.toContain("SHA256:")

		const row = await db
			.selectFrom("host")
			.select(["hostKeyFingerprint"])
			.where("id", "=", hostId)
			.executeTakeFirst()
		expect(row?.hostKeyFingerprint).toBe(ORIGINAL_FINGERPRINT)
	})
})

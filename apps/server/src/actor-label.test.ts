import { randomUUID } from "node:crypto"
import { trpcServer } from "@hono/trpc-server"
import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
import {
	createAuditController,
	createAuditControllerTransaction,
	createHostController,
	createHostControllerTransaction,
	createHostRepository,
	createSecretStore,
	createSshKeyController,
	createSshKeyControllerTransaction,
	createSshKeyRepository,
	generateKeyPair,
	generateSshKeyPair,
	provisionableHost,
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
const encodeAlgorithmBlob = (algorithm: string, extra: Buffer): Buffer => {
	const name = Buffer.from(algorithm, "ascii")
	const length = Buffer.alloc(4)
	length.writeUInt32BE(name.length, 0)
	return Buffer.concat([length, name, extra])
}
const HOST_KEY_BLOB = encodeAlgorithmBlob("ssh-ed25519", Buffer.from("actor-label-test-key"))
const HOST_KEY_FINGERPRINT = fingerprintFromKey(HOST_KEY_BLOB)

let db: Db
let app: Hono
let secretsStore: Awaited<ReturnType<typeof createSecretStore>>
let sshKeyRepository: ReturnType<typeof createSshKeyRepository>

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
	secretsStore = secrets

	const hosts = createHostRepository(db)
	const sshKeys = createSshKeyRepository(db)
	sshKeyRepository = sshKeys
	const hostController = createHostController({
		hosts,
		sshKeys,
		secrets,
		probeHostKey: async () => HOST_KEY_BLOB,
		evictHost: () => undefined,
		now: () => new Date(),
		createTransport: () => createFakeTransport(provisionableHost()),
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
				destinationController: createTestDestinationController(db, secretsStore),
				sshKeyController,
				selfHostController: createTestSelfHostController(db),
				memberController: memberControllerFor(db, auth, () => undefined),
				auditController: createAuditController({
					withTransaction: createAuditControllerTransaction(db),
				}),
			}),
		}),
	)
})

afterAll(async () => {
	await db.destroy()
})

const orgResponseSchema = z.object({ id: z.string() })
const dataIdResponseSchema = z.object({ result: z.object({ data: z.object({ id: z.string() }) }) })

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
		await db.deleteFrom("sshKey").where("organizationId", "in", organizationIds).execute()
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

describe("actor label derivation gate", () => {
	it("uses the session-derived email, not a client-supplied actorLabel field or header, and exposes provision", async () => {
		const email = seededEmail()
		const password = "correct horse battery staple 1"

		const signUpRes = await app.request("/api/auth/sign-up/email", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ email, password, name: "Actor Label Test" }),
		})
		expect(signUpRes.status).toBe(200)
		const cookie = extractCookie(signUpRes)
		expect(cookie.length).toBeGreaterThan(0)

		const orgSlug = `org-${randomUUID()}`
		const createOrgRes = await app.request("/api/auth/organization/create", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({ name: "Actor Label Org", slug: orgSlug }),
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

		const sealed = secretsStore.seal("dummy-private-key-material")
		const sshKeyRow = await sshKeyRepository.insert(
			{ organizationId: org.id },
			{
				name: "actor-label-test-key",
				publicKey: "ssh-ed25519 AAAAtest",
				privateKeyEncrypted: sealed.ciphertext,
				privateKeyKeyId: sealed.keyId,
			},
		)

		const spoofedLabel = "attacker@evil.example"
		const enrollRes = await app.request("/trpc/host.enroll", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Origin: ORIGIN,
				Cookie: cookie,
				"x-actor-label": spoofedLabel,
			},
			body: JSON.stringify({
				name: "vps-1",
				hostname: "10.0.0.9",
				port: 22,
				username: "root",
				sshKeyId: sshKeyRow.id,
				expectedFingerprint: HOST_KEY_FINGERPRINT,
				actorLabel: spoofedLabel,
			}),
		})
		const enrollBody = await enrollRes.text()
		expect(enrollRes.status, enrollBody).toBe(200)
		const created = dataIdResponseSchema.parse(JSON.parse(enrollBody)).result.data

		const hostRow = await db
			.selectFrom("host")
			.select(["hostKeyTrustedByLabel"])
			.where("id", "=", created.id)
			.executeTakeFirst()
		expect(hostRow?.hostKeyTrustedByLabel).toBe(email)
		expect(hostRow?.hostKeyTrustedByLabel).not.toBe(spoofedLabel)

		const auditRow = await db
			.selectFrom("auditEvent")
			.select(["actorLabel"])
			.where("subjectId", "=", created.id)
			.where("action", "=", "host.enroll")
			.executeTakeFirst()
		expect(auditRow?.actorLabel).toBe(email)
		expect(auditRow?.actorLabel).not.toBe(spoofedLabel)

		const provisionRes = await app.request("/trpc/host.provision", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({ hostId: created.id }),
		})
		const provisionBody = await provisionRes.text()
		expect(provisionRes.status, provisionBody).toBe(200)
		const provisioned = dataIdResponseSchema.parse(JSON.parse(provisionBody)).result.data
		expect(provisioned.id).toBe(created.id)

		const provisionedRow = await db
			.selectFrom("host")
			.select(["status"])
			.where("id", "=", created.id)
			.executeTakeFirst()
		expect(provisionedRow?.status).toBe("ready")
	})
})

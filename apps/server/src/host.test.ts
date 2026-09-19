import { randomUUID } from "node:crypto"
import { trpcServer } from "@hono/trpc-server"
import { hostPublic } from "@open-mcc/contracts"
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
	type SecretStore,
} from "@open-mcc/core"
import { createDb, type Db, type JsonObject } from "@open-mcc/db"
import { createFakeRootSession, createFakeTransport } from "@open-mcc/transport"
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

const PRESENTED_HOST_KEY = encodeAlgorithmBlob("ssh-ed25519", Buffer.from("host-public-test-key"))
const PRESENTED_FINGERPRINT = fingerprintFromKey(PRESENTED_HOST_KEY)

const STALE_CLAIM_AGE_MS = 60 * 60 * 1000

const WITHHELD_HOST_FIELDS = [
	"provisioningAttemptId",
	"provisioningClaimedAt",
	"sshKeyId",
	"hostKeyTrustedBy",
	"organizationId",
]

const PUBLIC_HOST_FIELDS = Object.keys(hostPublic.shape).sort()

let db: Db
let app: Hono
let secrets: SecretStore

beforeAll(async () => {
	db = createDb(process.env.TEST_DATABASE_URL ?? "")
	const auth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000", {
		trustedOrigins: [ORIGIN],
		disableSignUp: false,
		userCreation: "trusted",
		disableRateLimit: true,
		allowOrganizationCreation: true,
	})
	secrets = await createSecretStore(await generateKeyPair("hostpublicsealbox"))
	const hosts = createHostRepository(db)
	const sshKeys = createSshKeyRepository(db)

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
				singleSignOn: null,
				databaseUrl: process.env.TEST_DATABASE_URL ?? "",
				db,
				hostController: createHostController({
					hosts,
					sshKeys,
					secrets,
					probeHostKey: async () => PRESENTED_HOST_KEY,
					probeSshHandshake: async () => ({ kind: "key", key: Buffer.alloc(0) }),
					createTransport: () => createFakeTransport(provisionableHost()),
					createRootSession: () => createFakeRootSession(),
					evictHost: () => undefined,
					now: () => new Date(),
					withTransaction: createHostControllerTransaction(db, async () => null),
				}),
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
				sshKeyController: createSshKeyController({
					sshKeys,
					secrets,
					generateKeyPair: generateSshKeyPair,
					withTransaction: createSshKeyControllerTransaction(db),
				}),
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

const shownResponseSchema = z.object({
	result: z.object({
		data: z.union([z.array(z.object({}).passthrough()), z.object({}).passthrough()]),
	}),
})

const shownEntries = (text: string) => {
	const data = shownResponseSchema.parse(JSON.parse(text)).result.data
	return Array.isArray(data) ? data : [data]
}

const extractCookie = (res: Response): string =>
	res.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ")

let seededOrganizationIds: string[] = []
let seededEmails: string[] = []

afterEach(async () => {
	const organizationIds = seededOrganizationIds
	const emails = seededEmails
	seededOrganizationIds = []
	seededEmails = []
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
})

const signUpAndActivate = async (): Promise<{
	cookie: string
	orgId: string
	memberId: string
}> => {
	const email = `${randomUUID()}@example.com`
	seededEmails.push(email)
	const signUpRes = await app.request("/api/auth/sign-up/email", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({ email, password: "correct horse battery staple 1", name: "Host Test" }),
	})
	expect(signUpRes.status).toBe(200)
	const cookie = extractCookie(signUpRes)

	const createOrgRes = await app.request("/api/auth/organization/create", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ name: "Host Org", slug: `org-${randomUUID()}` }),
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

	const member = await db
		.selectFrom("member")
		.select("id")
		.where("organizationId", "=", org.id)
		.executeTakeFirstOrThrow()

	return { cookie, orgId: org.id, memberId: member.id }
}

const actAs = async (orgId: string, role: string): Promise<void> => {
	await db.updateTable("member").set({ role }).where("organizationId", "=", orgId).execute()
}

const seedHost = async (
	orgId: string,
	memberId: string,
): Promise<{ hostId: string; sshKeyId: string }> => {
	const sshKeyId = randomUUID()
	const sealed = secrets.seal("PRIVATE KEY")
	await db
		.insertInto("sshKey")
		.values({
			id: sshKeyId,
			organizationId: orgId,
			name: `key-${sshKeyId}`,
			publicKey: "ssh-ed25519 AAAA",
			privateKeyEncrypted: sealed.ciphertext,
			privateKeyKeyId: sealed.keyId,
		})
		.execute()
	const hostId = randomUUID()
	await db
		.insertInto("host")
		.values({
			id: hostId,
			organizationId: orgId,
			name: `vps-${hostId}`,
			hostname: "10.0.0.42",
			username: "mcc",
			status: "provisioning",
			sshKeyId,
			hostKeyAlgorithm: "ssh-ed25519",
			hostKeyFingerprint: PRESENTED_FINGERPRINT,
			hostKeyTrustedBy: memberId,
			hostKeyTrustedByLabel: "seed@example.com",
			hostKeyTrustedAt: new Date(),
			provisioningAttemptId: randomUUID(),
			provisioningClaimedAt: new Date(Date.now() - STALE_CLAIM_AGE_MS),
		})
		.execute()
	return { hostId, sshKeyId }
}

const post = async (path: string, cookie: string, input: JsonObject): Promise<Response> =>
	await app.request(`/trpc/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(input),
	})

const HOST_PROCEDURES = [
	{
		procedure: "list",
		role: "viewer",
		send: async (cookie: string) =>
			await app.request("/trpc/host.list", { headers: { Origin: ORIGIN, Cookie: cookie } }),
	},
	{
		procedure: "enroll",
		role: "owner",
		send: (cookie: string, seeded: { sshKeyId: string }) =>
			post("host.enroll", cookie, {
				name: "enrolled-host",
				hostname: "10.0.0.43",
				port: 22,
				username: "mcc",
				sshKeyId: seeded.sshKeyId,
				expectedFingerprint: PRESENTED_FINGERPRINT,
			}),
	},
	{
		procedure: "provision",
		role: "owner",
		send: (cookie: string, seeded: { hostId: string }) =>
			post("host.provision", cookie, { hostId: seeded.hostId }),
	},
	{
		procedure: "retrustHostKey",
		role: "owner",
		send: (cookie: string, seeded: { hostId: string }) =>
			post("host.retrustHostKey", cookie, {
				hostId: seeded.hostId,
				hostKeyFingerprint: PRESENTED_FINGERPRINT,
			}),
	},
]

describe("what a host procedure sends the browser", () => {
	it.each(HOST_PROCEDURES)(
		"★ host.$procedure hands a $role exactly the public host fields",
		async ({ role, send }) => {
			const { cookie, orgId, memberId } = await signUpAndActivate()
			const seeded = await seedHost(orgId, memberId)
			await actAs(orgId, role)

			const res = await send(cookie, seeded)
			const text = await res.text()
			expect(res.status, text).toBe(200)

			const entries = shownEntries(text)
			expect(entries.length).toBeGreaterThan(0)
			for (const entry of entries) {
				expect(Object.keys(entry).sort()).toEqual(PUBLIC_HOST_FIELDS)
			}
		},
	)

	it.each(HOST_PROCEDURES)(
		"★ host.$procedure never carries the provisioning claim, the key it signs in with or who trusted it",
		async ({ role, send }) => {
			const { cookie, orgId, memberId } = await signUpAndActivate()
			const seeded = await seedHost(orgId, memberId)
			await actAs(orgId, role)

			const res = await send(cookie, seeded)
			const text = await res.text()
			expect(res.status, text).toBe(200)

			for (const field of WITHHELD_HOST_FIELDS) {
				expect(PUBLIC_HOST_FIELDS).not.toContain(field)
				for (const entry of shownEntries(text)) {
					expect(Object.keys(entry)).not.toContain(field)
				}
			}

			const stored = await db
				.selectFrom("host")
				.select(["provisioningAttemptId", "sshKeyId", "hostKeyTrustedBy", "organizationId"])
				.where("organizationId", "=", orgId)
				.execute()
			const withheldValues = stored
				.flatMap((row) => [
					row.provisioningAttemptId,
					row.sshKeyId,
					row.hostKeyTrustedBy,
					row.organizationId,
				])
				.filter((value) => value !== null)
			expect(withheldValues.length).toBeGreaterThan(0)
			for (const value of withheldValues) {
				expect(text).not.toContain(value)
			}
		},
	)
})

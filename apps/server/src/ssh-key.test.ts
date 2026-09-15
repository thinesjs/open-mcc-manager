import { randomUUID } from "node:crypto"
import { trpcServer } from "@hono/trpc-server"
import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
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
import { afterAll, beforeAll, describe, expect, it } from "vitest"
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
const SEALBOX_KEY_ID = "sshkeytestsealbox"

const encodeAlgorithmBlob = (algorithm: string, extra: Buffer): Buffer => {
	const name = Buffer.from(algorithm, "ascii")
	const length = Buffer.alloc(4)
	length.writeUInt32BE(name.length, 0)
	return Buffer.concat([length, name, extra])
}

const PRESENTED_HOST_KEY = encodeAlgorithmBlob("ssh-ed25519", Buffer.from("ssh-key-test-host-key"))
const PRESENTED_FINGERPRINT = fingerprintFromKey(PRESENTED_HOST_KEY)

let db: Db
let app: Hono

beforeAll(async () => {
	db = createDb(process.env.TEST_DATABASE_URL ?? "")
	const auth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000", {
		trustedOrigins: [ORIGIN],
		disableSignUp: false,
		userCreation: "trusted",
		disableRateLimit: true,
		allowOrganizationCreation: true,
	})
	const secrets = await createSecretStore(await generateKeyPair(SEALBOX_KEY_ID))

	const sshKeys = createSshKeyRepository(db)
	const hostController = createHostController({
		hosts: createHostRepository(db),
		sshKeys,
		secrets,
		probeHostKey: async () => PRESENTED_HOST_KEY,
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
const errorResponseSchema = z.object({
	error: z.object({ data: z.object({ errorCode: z.string().optional() }) }),
})
const sshKeyPublicSchema = z.object({
	id: z.string(),
	name: z.string(),
	publicKey: z.string(),
	createdAt: z.string(),
})
const createResponseSchema = z.object({ result: z.object({ data: sshKeyPublicSchema }) })
const listResponseSchema = z.object({ result: z.object({ data: z.array(sshKeyPublicSchema) }) })
const enrollResponseSchema = z.object({ result: z.object({ data: z.object({ id: z.string() }) }) })
const removeResponseSchema = z.object({
	result: z.object({ data: z.object({ deleted: z.boolean() }) }),
})

const PUBLIC_SSH_KEY_FIELDS = ["createdAt", "id", "name", "publicKey"]

type Tenant = { email: string; cookie: string; orgId: string }

const extractCookie = (res: Response): string =>
	res.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ")

const signUp = async (): Promise<{ email: string; cookie: string }> => {
	const email = `${randomUUID()}@example.com`
	const res = await app.request("/api/auth/sign-up/email", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({ email, password: "correct horse battery staple 1", name: "Key Test" }),
	})
	expect(res.status).toBe(200)
	return { email, cookie: extractCookie(res) }
}

const setActiveOrganization = async (cookie: string, organizationId: string): Promise<void> => {
	const res = await app.request("/api/auth/organization/set-active", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ organizationId }),
	})
	expect(res.status).toBe(200)
}

const signUpOwner = async (): Promise<Tenant> => {
	const { email, cookie } = await signUp()
	const createOrgRes = await app.request("/api/auth/organization/create", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ name: "Key Org", slug: `org-${randomUUID()}` }),
	})
	expect(createOrgRes.status).toBe(200)
	const org = orgResponseSchema.parse(await createOrgRes.json())
	await setActiveOrganization(cookie, org.id)
	return { email, cookie, orgId: org.id }
}

const signUpViewer = async (orgId: string): Promise<Tenant> => {
	const { email, cookie } = await signUp()
	const user = await db
		.selectFrom("user")
		.select("id")
		.where("email", "=", email)
		.executeTakeFirstOrThrow()
	await db
		.insertInto("member")
		.values({ id: randomUUID(), organizationId: orgId, userId: user.id })
		.execute()
	await setActiveOrganization(cookie, orgId)
	return { email, cookie, orgId }
}

type JsonBody = Record<string, string | number>

const post = (path: string, cookie: string, body: JsonBody) =>
	app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(body),
	})

const get = (path: string, cookie: string) =>
	app.request(path, { method: "GET", headers: { Origin: ORIGIN, Cookie: cookie } })

const createSshKey = async (tenant: Tenant, name: string): Promise<string> => {
	const res = await post("/trpc/sshKey.create", tenant.cookie, { name })
	const body = await res.text()
	expect(res.status, body).toBe(200)
	return createResponseSchema.parse(JSON.parse(body)).result.data.id
}

const enrollHost = async (tenant: Tenant, name: string, sshKeyId: string): Promise<string> => {
	const res = await post("/trpc/host.enroll", tenant.cookie, {
		name,
		hostname: "10.0.0.42",
		port: 22,
		username: "root",
		sshKeyId,
		expectedFingerprint: PRESENTED_FINGERPRINT,
	})
	const body = await res.text()
	expect(res.status, body).toBe(200)
	return enrollResponseSchema.parse(JSON.parse(body)).result.data.id
}

const sealedRow = (sshKeyId: string) =>
	db
		.selectFrom("sshKey")
		.select(["privateKeyEncrypted", "privateKeyKeyId"])
		.where("id", "=", sshKeyId)
		.executeTakeFirstOrThrow()

const cleanUp = async (tenants: Tenant[]): Promise<void> => {
	if (tenants.length === 0) return
	const orgIds = tenants.map((tenant) => tenant.orgId)
	const emails = tenants.map((tenant) => tenant.email)
	await db.deleteFrom("auditEvent").where("organizationId", "in", orgIds).execute()
	await db.deleteFrom("host").where("organizationId", "in", orgIds).execute()
	await db.deleteFrom("sshKey").where("organizationId", "in", orgIds).execute()
	await db.deleteFrom("invitation").where("organizationId", "in", orgIds).execute()
	await db.deleteFrom("member").where("organizationId", "in", orgIds).execute()
	await db.deleteFrom("organization").where("id", "in", orgIds).execute()
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

describe("sshKey.create", () => {
	it("returns the public projection and never the sealed private key material", async () => {
		const owner = await signUpOwner()
		try {
			const res = await post("/trpc/sshKey.create", owner.cookie, { name: "deploy" })
			const body = await res.text()
			expect(res.status, body).toBe(200)

			const created = createResponseSchema.parse(JSON.parse(body)).result.data
			expect(Object.keys(created).sort()).toEqual(PUBLIC_SSH_KEY_FIELDS)

			const stored = await sealedRow(created.id)
			expect(stored.privateKeyEncrypted.length).toBeGreaterThan(0)
			expect(body).not.toContain(stored.privateKeyEncrypted)
			expect(body).not.toContain(stored.privateKeyKeyId)
			expect(body).not.toContain("privateKey")
			expect(body).not.toContain("PRIVATE KEY")
		} finally {
			await cleanUp([owner])
		}
	})

	it("audits the creation against the acting member", async () => {
		const owner = await signUpOwner()
		try {
			const sshKeyId = await createSshKey(owner, "audited")
			const audit = await db
				.selectFrom("auditEvent")
				.select(["actorLabel", "action"])
				.where("subjectId", "=", sshKeyId)
				.where("action", "=", "sshKey.create")
				.executeTakeFirst()
			expect(audit?.actorLabel).toBe(owner.email)
		} finally {
			await cleanUp([owner])
		}
	})

	it("rejects a duplicate key name with a conflict rather than an internal error", async () => {
		const owner = await signUpOwner()
		try {
			await createSshKey(owner, "duplicate")

			const res = await post("/trpc/sshKey.create", owner.cookie, { name: "duplicate" })
			const body = await res.text()
			expect(res.status, body).toBe(409)
			expect(body).not.toContain("Internal server error")
			expect(body).not.toContain(owner.orgId)
			expect(errorResponseSchema.parse(JSON.parse(body)).error.data.errorCode).toBe(
				"SSH_KEY_NAME_TAKEN",
			)

			const rows = await db
				.selectFrom("sshKey")
				.select("id")
				.where("organizationId", "=", owner.orgId)
				.execute()
			expect(rows).toHaveLength(1)
		} finally {
			await cleanUp([owner])
		}
	})

	it("rejects a viewer without creating a key", async () => {
		const owner = await signUpOwner()
		const viewer = await signUpViewer(owner.orgId)
		try {
			const res = await post("/trpc/sshKey.create", viewer.cookie, { name: "forbidden" })
			const body = await res.text()
			expect(res.status, body).toBe(403)
			expect(errorResponseSchema.parse(JSON.parse(body)).error.data.errorCode).toBe("FORBIDDEN")

			const rows = await db
				.selectFrom("sshKey")
				.select("id")
				.where("organizationId", "=", owner.orgId)
				.execute()
			expect(rows).toHaveLength(0)
		} finally {
			await cleanUp([owner, viewer])
		}
	})
})

describe("sshKey.list", () => {
	it("returns the public projection and never the sealed private key material", async () => {
		const owner = await signUpOwner()
		try {
			const sshKeyId = await createSshKey(owner, "listed")
			const stored = await sealedRow(sshKeyId)

			const res = await get("/trpc/sshKey.list", owner.cookie)
			const body = await res.text()
			expect(res.status, body).toBe(200)

			const listed = listResponseSchema.parse(JSON.parse(body)).result.data
			expect(listed).toHaveLength(1)
			for (const item of listed) {
				expect(Object.keys(item).sort()).toEqual(PUBLIC_SSH_KEY_FIELDS)
			}
			expect(body).not.toContain(stored.privateKeyEncrypted)
			expect(body).not.toContain(stored.privateKeyKeyId)
			expect(body).not.toContain("privateKey")
			expect(body).not.toContain("PRIVATE KEY")
		} finally {
			await cleanUp([owner])
		}
	})

	it("never lists another organization's keys", async () => {
		const first = await signUpOwner()
		const second = await signUpOwner()
		try {
			const foreignKeyId = await createSshKey(first, "first-org-key")

			const res = await get("/trpc/sshKey.list", second.cookie)
			const body = await res.text()
			expect(res.status, body).toBe(200)
			expect(listResponseSchema.parse(JSON.parse(body)).result.data).toEqual([])
			expect(body).not.toContain(foreignKeyId)
		} finally {
			await cleanUp([first, second])
		}
	})

	it("rejects a viewer", async () => {
		const owner = await signUpOwner()
		const viewer = await signUpViewer(owner.orgId)
		try {
			const res = await get("/trpc/sshKey.list", viewer.cookie)
			const body = await res.text()
			expect(res.status, body).toBe(403)
			expect(errorResponseSchema.parse(JSON.parse(body)).error.data.errorCode).toBe("FORBIDDEN")
		} finally {
			await cleanUp([owner, viewer])
		}
	})
})

describe("sshKey.remove", () => {
	it("deletes an unused key and audits the deletion", async () => {
		const owner = await signUpOwner()
		try {
			const sshKeyId = await createSshKey(owner, "removable")

			const res = await post("/trpc/sshKey.remove", owner.cookie, { sshKeyId })
			const body = await res.text()
			expect(res.status, body).toBe(200)
			expect(removeResponseSchema.parse(JSON.parse(body)).result.data.deleted).toBe(true)

			const remaining = await db
				.selectFrom("sshKey")
				.select("id")
				.where("id", "=", sshKeyId)
				.executeTakeFirst()
			expect(remaining).toBeUndefined()

			const audit = await db
				.selectFrom("auditEvent")
				.select("actorLabel")
				.where("subjectId", "=", sshKeyId)
				.where("action", "=", "sshKey.delete")
				.executeTakeFirst()
			expect(audit?.actorLabel).toBe(owner.email)
		} finally {
			await cleanUp([owner])
		}
	})

	it("refuses to delete a key an enrolled host still uses, keeping the key and writing no audit row", async () => {
		const owner = await signUpOwner()
		try {
			const sshKeyId = await createSshKey(owner, "in-use")
			await enrollHost(owner, "vps-in-use", sshKeyId)

			const res = await post("/trpc/sshKey.remove", owner.cookie, { sshKeyId })
			const body = await res.text()
			expect(res.status, body).toBe(409)
			expect(body).not.toContain("Internal server error")
			expect(body).not.toContain(owner.orgId)
			expect(body).not.toContain("host_sshKey_org_fk")
			expect(errorResponseSchema.parse(JSON.parse(body)).error.data.errorCode).toBe(
				"SSH_KEY_IN_USE",
			)

			const remaining = await db
				.selectFrom("sshKey")
				.select("id")
				.where("id", "=", sshKeyId)
				.executeTakeFirst()
			expect(remaining?.id).toBe(sshKeyId)

			const audit = await db
				.selectFrom("auditEvent")
				.select("id")
				.where("subjectId", "=", sshKeyId)
				.where("action", "=", "sshKey.delete")
				.executeTakeFirst()
			expect(audit).toBeUndefined()
		} finally {
			await cleanUp([owner])
		}
	})

	it("never deletes another organization's key", async () => {
		const first = await signUpOwner()
		const second = await signUpOwner()
		try {
			const sshKeyId = await createSshKey(first, "protected")

			const res = await post("/trpc/sshKey.remove", second.cookie, { sshKeyId })
			const body = await res.text()
			expect(res.status, body).toBe(200)
			expect(removeResponseSchema.parse(JSON.parse(body)).result.data.deleted).toBe(false)

			const remaining = await db
				.selectFrom("sshKey")
				.select("id")
				.where("id", "=", sshKeyId)
				.executeTakeFirst()
			expect(remaining?.id).toBe(sshKeyId)
		} finally {
			await cleanUp([first, second])
		}
	})

	it("rejects a viewer without deleting the key", async () => {
		const owner = await signUpOwner()
		const viewer = await signUpViewer(owner.orgId)
		try {
			const sshKeyId = await createSshKey(owner, "viewer-cannot-delete")

			const res = await post("/trpc/sshKey.remove", viewer.cookie, { sshKeyId })
			const body = await res.text()
			expect(res.status, body).toBe(403)
			expect(errorResponseSchema.parse(JSON.parse(body)).error.data.errorCode).toBe("FORBIDDEN")

			const remaining = await db
				.selectFrom("sshKey")
				.select("id")
				.where("id", "=", sshKeyId)
				.executeTakeFirst()
			expect(remaining?.id).toBe(sshKeyId)
		} finally {
			await cleanUp([owner, viewer])
		}
	})
})

describe("host.enroll name conflicts", () => {
	it("rejects a duplicate host name with a conflict rather than an internal error", async () => {
		const owner = await signUpOwner()
		try {
			const sshKeyId = await createSshKey(owner, "enrolment")
			await enrollHost(owner, "vps-duplicate", sshKeyId)

			const res = await post("/trpc/host.enroll", owner.cookie, {
				name: "vps-duplicate",
				hostname: "10.0.0.43",
				port: 22,
				username: "root",
				sshKeyId,
				expectedFingerprint: PRESENTED_FINGERPRINT,
			})
			const body = await res.text()
			expect(res.status, body).toBe(409)
			expect(body).not.toContain("Internal server error")
			expect(body).not.toContain(owner.orgId)
			expect(body).not.toContain("host_org_name_unique")
			expect(errorResponseSchema.parse(JSON.parse(body)).error.data.errorCode).toBe(
				"HOST_NAME_TAKEN",
			)

			const hosts = await db
				.selectFrom("host")
				.select("id")
				.where("organizationId", "=", owner.orgId)
				.execute()
			expect(hosts).toHaveLength(1)
		} finally {
			await cleanUp([owner])
		}
	})
})

import { randomUUID } from "node:crypto"
import { trpcServer } from "@hono/trpc-server"
import { hostPublic, type SelfHostOffer, selfHostPublicOffer } from "@open-mcc/contracts"
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
	type InstanceController,
	type SecretStore,
	type SelfHostMaterials,
} from "@open-mcc/core"
import { createDb, type Db } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { Hono } from "hono"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { type Auth, createAuth } from "./auth"
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

const THIS_MACHINE = encodeAlgorithmBlob("ssh-ed25519", Buffer.from("self-host-test-this-machine"))
const SOME_OTHER_MACHINE = encodeAlgorithmBlob(
	"ssh-ed25519",
	Buffer.from("self-host-test-neighbour"),
)
const THIS_MACHINE_FINGERPRINT = fingerprintFromKey(THIS_MACHINE)

let db: Db
let auth: Auth
let secrets: SecretStore
let instanceController: InstanceController

beforeAll(async () => {
	db = createDb(process.env.TEST_DATABASE_URL ?? "")
	auth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000", {
		trustedOrigins: [ORIGIN],
		disableSignUp: false,
		userCreation: "trusted",
		disableRateLimit: true,
		allowOrganizationCreation: true,
	})
	secrets = await createSecretStore(await generateKeyPair("selfhosttest"))
	instanceController = await createTestInstanceController(db)
})

afterAll(async () => {
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

const appWith = (
	materials: SelfHostMaterials | undefined,
	presented: Buffer = THIS_MACHINE,
): Hono => {
	const sshKeys = createSshKeyRepository(db)
	const hostController = createHostController({
		hosts: createHostRepository(db),
		sshKeys,
		secrets,
		probeHostKey: async () => presented,
		createTransport: () => createFakeTransport(),
		evictHost: () => undefined,
		now: () => new Date(),
		withTransaction: createHostControllerTransaction(db, async () => null),
	})
	const app = new Hono()
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
				instanceController,
				statusController: createTestStatusController(db),
				destinationController: createTestDestinationController(db, secrets),
				sshKeyController: createSshKeyController({
					sshKeys,
					secrets,
					generateKeyPair: generateSshKeyPair,
					withTransaction: createSshKeyControllerTransaction(db),
				}),
				selfHostController: createTestSelfHostController(db, hostController.enroll, materials),
				memberController: memberControllerFor(db, auth, () => undefined),
				auditController: createAuditController({
					withTransaction: createAuditControllerTransaction(db),
				}),
			}),
		}),
	)
	return app
}

const materialsFor = (overrides: Partial<SelfHostOffer> = {}): SelfHostMaterials => {
	const pair = generateSshKeyPair("this machine")
	const sealed = secrets.seal(pair.privateKey)
	return {
		offer: {
			name: "this-machine",
			hostname: "host.docker.internal",
			port: 22,
			username: "mcc",
			fingerprint: THIS_MACHINE_FINGERPRINT,
			reach: "proven",
			systemd: true,
			linger: true,
			...overrides,
		},
		publicKey: pair.publicKey,
		privateKeyEncrypted: sealed.ciphertext,
		privateKeyKeyId: sealed.keyId,
	}
}

const orgResponseSchema = z.object({ id: z.string() })
const errorResponseSchema = z.object({
	error: z.object({ data: z.object({ errorCode: z.string().optional() }) }),
})
const offerResponseSchema = z.object({
	result: z.object({ data: selfHostPublicOffer.nullable() }),
})
const adoptResponseSchema = z.object({ result: z.object({ data: z.object({ id: z.string() }) }) })
const adoptedHostSchema = z.object({ result: z.object({ data: z.object({}).passthrough() }) })
const hostListResponseSchema = z.object({
	result: z.object({ data: z.array(z.object({ id: z.string(), hostname: z.string() })) }),
})

type Tenant = { cookie: string; orgId: string }

const extractCookie = (res: Response): string =>
	res.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ")

const signUp = async (app: Hono): Promise<{ email: string; cookie: string }> => {
	const email = `${randomUUID()}@example.com`
	seededEmails.push(email)
	const res = await app.request("/api/auth/sign-up/email", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({ email, password: "correct horse battery staple 1", name: "Self Host" }),
	})
	expect(res.status).toBe(200)
	return { email, cookie: extractCookie(res) }
}

const setActiveOrganization = async (app: Hono, cookie: string, organizationId: string) => {
	const res = await app.request("/api/auth/organization/set-active", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ organizationId }),
	})
	expect(res.status).toBe(200)
}

const signUpOwner = async (app: Hono): Promise<Tenant> => {
	const { cookie } = await signUp(app)
	const res = await app.request("/api/auth/organization/create", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ name: "Self Host Org", slug: `org-${randomUUID()}` }),
	})
	expect(res.status).toBe(200)
	const org = orgResponseSchema.parse(await res.json())
	seededOrganizationIds.push(org.id)
	await setActiveOrganization(app, cookie, org.id)
	return { cookie, orgId: org.id }
}

const signUpViewer = async (app: Hono, orgId: string): Promise<Tenant> => {
	const { email, cookie } = await signUp(app)
	const user = await db
		.selectFrom("user")
		.select("id")
		.where("email", "=", email)
		.executeTakeFirstOrThrow()
	await db
		.insertInto("member")
		.values({ id: randomUUID(), organizationId: orgId, userId: user.id })
		.execute()
	await setActiveOrganization(app, cookie, orgId)
	return { cookie, orgId }
}

const offerFor = async (app: Hono, tenant: Tenant) => {
	const res = await app.request("/trpc/selfHost.offer", {
		method: "GET",
		headers: { Origin: ORIGIN, Cookie: tenant.cookie },
	})
	expect(res.status).toBe(200)
	const text = await res.text()
	return { text, data: offerResponseSchema.parse(JSON.parse(text)).result.data }
}

const adopt = (app: Hono, tenant: Tenant) =>
	app.request("/trpc/selfHost.adopt", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: tenant.cookie },
	})

const errorCodeOf = async (res: Response): Promise<string | undefined> =>
	errorResponseSchema.parse(await res.json()).error.data.errorCode

const hostsIn = async (orgId: string) =>
	db.selectFrom("host").selectAll().where("organizationId", "=", orgId).execute()

describe("the machine the dashboard offers", () => {
	it("is offered to an owner, without the sealed key that opens it", async () => {
		const materials = materialsFor()
		const app = appWith(materials)
		const owner = await signUpOwner(app)

		const offered = await offerFor(app, owner)

		expect(offered.data).toEqual(selfHostPublicOffer.parse(materials.offer))
		expect(offered.text).not.toContain(THIS_MACHINE_FINGERPRINT)
		expect(offered.text).not.toContain(materials.privateKeyEncrypted)
		expect(offered.text).not.toContain(materials.publicKey)
	})

	it("is not offered to a viewer, who could not add it", async () => {
		const app = appWith(materialsFor())
		const owner = await signUpOwner(app)
		const viewer = await signUpViewer(app, owner.orgId)

		expect((await offerFor(app, viewer)).data).toBeNull()
	})

	it("is absent, not an error, when the installer left nothing behind", async () => {
		const app = appWith(undefined)
		const owner = await signUpOwner(app)

		expect((await offerFor(app, owner)).data).toBeNull()
	})
})

describe("adding the machine the dashboard offers", () => {
	it("stores the key the installer sealed and enrolls the host against the machine's own key", async () => {
		const materials = materialsFor()
		const app = appWith(materials)
		const owner = await signUpOwner(app)

		const res = await adopt(app, owner)
		const body = await res.text()
		expect(res.status, body).toBe(200)
		const hostId = adoptResponseSchema.parse(JSON.parse(body)).result.data.id

		const [host] = await hostsIn(owner.orgId)
		expect(host?.id).toBe(hostId)
		expect(host?.hostKeyFingerprint).toBe(THIS_MACHINE_FINGERPRINT)
		expect(host?.status).toBe("pending")

		const key = await db
			.selectFrom("sshKey")
			.selectAll()
			.where("organizationId", "=", owner.orgId)
			.executeTakeFirstOrThrow()
		expect(host?.sshKeyId).toBe(key.id)
		expect(key.privateKeyEncrypted).toBe(materials.privateKeyEncrypted)
		expect(key.publicKey).toBe(materials.publicKey)
		expect(secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId)).toContain(
			"OPENSSH PRIVATE KEY",
		)
	})

	it("★ hands back only the public host fields for the machine it added", async () => {
		const app = appWith(materialsFor())
		const owner = await signUpOwner(app)

		const res = await adopt(app, owner)
		const text = await res.text()
		expect(res.status, text).toBe(200)

		const added = adoptedHostSchema.parse(JSON.parse(text)).result.data
		expect(Object.keys(added).sort()).toEqual(Object.keys(hostPublic.shape).sort())

		const withheld = (await hostsIn(owner.orgId))
			.flatMap((host) => [host.sshKeyId, host.hostKeyTrustedBy, host.organizationId])
			.filter((value) => value !== null)
		expect(withheld.length).toBeGreaterThan(0)
		for (const value of withheld) {
			expect(text).not.toContain(value)
		}
	})

	it("refuses when the address answers with a key other than the one the installer read", async () => {
		const app = appWith(materialsFor(), SOME_OTHER_MACHINE)
		const owner = await signUpOwner(app)

		const res = await adopt(app, owner)

		expect(res.status).toBe(400)
		expect(await errorCodeOf(res)).toBe("FINGERPRINT_MISMATCH")
		expect(await hostsIn(owner.orgId)).toEqual([])
	})

	it.each([{ reach: "reachable" as const }, { reach: "unproven" as const }])(
		"refuses a machine no container proved it could reach, $reach",
		async ({ reach }) => {
			const app = appWith(materialsFor({ reach }))
			const owner = await signUpOwner(app)

			const res = await adopt(app, owner)

			expect(res.status).toBe(400)
			expect(await errorCodeOf(res)).toBe("SELF_HOST_UNAVAILABLE")
			expect(await hostsIn(owner.orgId)).toEqual([])
		},
	)

	it("refuses a viewer", async () => {
		const app = appWith(materialsFor())
		const owner = await signUpOwner(app)
		const viewer = await signUpViewer(app, owner.orgId)

		const res = await adopt(app, viewer)

		expect(res.status).toBe(403)
		expect(await errorCodeOf(res)).toBe("FORBIDDEN")
		expect(await hostsIn(owner.orgId)).toEqual([])
	})

	it("adds the machine to the organization that asked and to no other", async () => {
		const app = appWith(materialsFor())
		const first = await signUpOwner(app)
		const second = await signUpOwner(app)

		const res = await adopt(app, first)
		expect(res.status, await res.clone().text()).toBe(200)

		const listed = await app.request("/trpc/host.list", {
			method: "GET",
			headers: { Origin: ORIGIN, Cookie: second.cookie },
		})
		expect(hostListResponseSchema.parse(await listed.json()).result.data).toEqual([])
		expect(await hostsIn(second.orgId)).toEqual([])
		expect(await hostsIn(first.orgId)).toHaveLength(1)
	})
})

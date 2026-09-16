import { randomUUID } from "node:crypto"
import { trpcServer } from "@hono/trpc-server"
import type { Role } from "@open-mcc/contracts"
import {
	type AuditController,
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
const PASSWORD = "correct horse battery staple 1"
const OPEN_DOOR_TOTAL = 4321

const controllerGate = { checksCapability: true }

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
	const secrets = await createSecretStore(await generateKeyPair("audittestsealbox"))
	const sshKeys = createSshKeyRepository(db)

	const real = createAuditController({ withTransaction: createAuditControllerTransaction(db) })
	const auditController: AuditController = {
		list: async (ctx, input) =>
			controllerGate.checksCapability
				? real.list(ctx, input)
				: { items: [], total: OPEN_DOOR_TOTAL },
	}

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
				hostController: createHostController({
					hosts: createHostRepository(db),
					sshKeys,
					secrets,
					probeHostKey: async () => Buffer.alloc(0),
					createTransport: () => createFakeTransport(),
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
				auditController,
			}),
		}),
	)
})

afterAll(async () => {
	await db.destroy()
})

const orgResponseSchema = z.object({ id: z.string() })
const pageResultSchema = z.object({
	result: z.object({
		data: z.object({
			items: z.array(z.object({ actorLabel: z.string(), action: z.string() })),
			total: z.number(),
		}),
	}),
})
const errorCodeSchema = z.object({
	error: z.object({ data: z.object({ errorCode: z.string().optional() }) }),
})

const extractCookie = (res: Response): string =>
	res.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ")

let seededOrganizationIds: string[] = []
let seededEmails: string[] = []

const seededEmail = (): string => {
	const email = `${randomUUID()}@example.com`
	seededEmails.push(email)
	return email
}

const post = (path: string, cookie: string, body: object): Promise<Response> =>
	Promise.resolve(
		app.request(path, {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify(body),
		}),
	)

const readAudit = (cookie: string): Promise<Response> =>
	Promise.resolve(
		app.request(`/trpc/audit.list?input=${encodeURIComponent(JSON.stringify({ offset: 0 }))}`, {
			method: "GET",
			headers: { Origin: ORIGIN, Cookie: cookie },
		}),
	)

const signUp = async (name: string) => {
	const email = seededEmail()
	const res = await post("/api/auth/sign-up/email", "", { email, password: PASSWORD, name })
	expect(res.status).toBe(200)
	const user = await db
		.selectFrom("user")
		.select("id")
		.where("email", "=", email)
		.executeTakeFirstOrThrow()
	return { email, cookie: extractCookie(res), userId: user.id }
}

const activate = async (cookie: string, organizationId: string): Promise<void> => {
	const res = await post("/api/auth/organization/set-active", cookie, { organizationId })
	expect(res.status).toBe(200)
}

const signUpOwner = async () => {
	const person = await signUp("Owner")
	const res = await post("/api/auth/organization/create", person.cookie, {
		name: "Audit Org",
		slug: `org-${randomUUID()}`,
	})
	expect(res.status).toBe(200)
	const org = orgResponseSchema.parse(await res.json())
	seededOrganizationIds.push(org.id)
	await activate(person.cookie, org.id)
	return { ...person, orgId: org.id }
}

const joinAs = async (organizationId: string, role: Role) => {
	const person = await signUp(role)
	await db
		.insertInto("member")
		.values({ id: randomUUID(), organizationId, userId: person.userId, role })
		.execute()
	await activate(person.cookie, organizationId)
	return person
}

afterEach(async () => {
	const organizationIds = seededOrganizationIds
	const emails = seededEmails
	seededOrganizationIds = []
	seededEmails = []
	controllerGate.checksCapability = true
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

describe("who the audit router lets through", () => {
	it("hands an owner the page and its total", async () => {
		const owner = await signUpOwner()

		const res = await readAudit(owner.cookie)
		const body = await res.text()

		expect(res.status, body).toBe(200)
		expect(pageResultSchema.parse(JSON.parse(body)).result.data.total).toBeGreaterThanOrEqual(0)
	})

	it.each(["operator", "viewer"] as const)("refuses a %s", async (role) => {
		const owner = await signUpOwner()
		const other = await joinAs(owner.orgId, role)

		const res = await readAudit(other.cookie)
		const body = await res.text()

		expect(res.status, body).toBe(403)
		expect(errorCodeSchema.parse(JSON.parse(body)).error.data.errorCode).toBe("FORBIDDEN")
	})

	it("refuses anyone who is not signed in at all", async () => {
		expect((await readAudit("")).status).toBe(401)
	})
})

describe("the gate the router itself holds", () => {
	it.each(["operator", "viewer"] as const)(
		"still refuses a %s when the controller behind it checks nothing",
		async (role) => {
			const owner = await signUpOwner()
			const other = await joinAs(owner.orgId, role)
			controllerGate.checksCapability = false

			const res = await readAudit(other.cookie)
			const body = await res.text()

			expect(res.status, body).toBe(403)
			expect(body).not.toContain(String(OPEN_DOOR_TOTAL))
		},
	)

	it("lets an owner through that same open door, so the refusal is the role and not the wiring", async () => {
		const owner = await signUpOwner()
		controllerGate.checksCapability = false

		const res = await readAudit(owner.cookie)
		const body = await res.text()

		expect(res.status, body).toBe(200)
		expect(pageResultSchema.parse(JSON.parse(body)).result.data.total).toBe(OPEN_DOOR_TOTAL)
	})
})

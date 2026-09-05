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
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Auth, createAuth } from "./auth"
import { createRequestContext } from "./create-context"
import { appRouter } from "./routers/index"
import { requireSameOrigin, strictCors } from "./security/cors"
import { securityHeaders } from "./security/headers"
import { createTestInstanceController } from "./test/instance-controller"

const ORIGIN = "http://localhost:5173"
const PASSWORD = "correct horse battery staple 6"

let db: Db
let app: Hono
let signupAuth: Auth

beforeAll(async () => {
	db = createDb(process.env.TEST_DATABASE_URL ?? "")
	const auth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000", {
		trustedOrigins: [ORIGIN],
		disableRateLimit: true,
	})
	signupAuth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000", {
		trustedOrigins: [ORIGIN],
		disableSignUp: false,
		disableRateLimit: true,
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
				signupAuth,
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

const extractCookie = (res: Response): string => {
	const cookies = res.headers.getSetCookie()
	return cookies.map((cookie) => cookie.split(";")[0]).join("; ")
}

const createSshKeyAs = async (cookie: string, name: string): Promise<Response> =>
	app.request("/trpc/sshKey.create", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ name }),
	})

describe("organization creation through the mounted auth handler", () => {
	it("refuses an authenticated user, leaving them with no membership and no capability", async () => {
		const email = `${randomUUID()}@example.com`
		const signUp = await signupAuth.api.signUpEmail({
			body: { email, password: PASSWORD, name: "Uninvited Escalator" },
		})
		const slug = `org-${randomUUID()}`
		const beforeKeyName = `before-${slug}`
		const afterKeyName = `after-${slug}`

		try {
			const signInRes = await app.request("/api/auth/sign-in/email", {
				method: "POST",
				headers: { "content-type": "application/json", Origin: ORIGIN },
				body: JSON.stringify({ email, password: PASSWORD }),
			})
			const signInBody = await signInRes.text()
			expect(signInRes.status, signInBody).toBe(200)
			const cookie = extractCookie(signInRes)

			const beforeRes = await createSshKeyAs(cookie, beforeKeyName)
			expect(beforeRes.status, await beforeRes.text()).toBe(401)

			const createOrgRes = await app.request("/api/auth/organization/create", {
				method: "POST",
				headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
				body: JSON.stringify({ name: "Escalation Org", slug }),
			})
			const createOrgBody = await createOrgRes.text()
			expect(createOrgRes.status, createOrgBody).toBe(403)

			const organizations = await db
				.selectFrom("organization")
				.select("id")
				.where("slug", "=", slug)
				.execute()
			expect(organizations).toHaveLength(0)

			const members = await db
				.selectFrom("member")
				.select("role")
				.where("userId", "=", signUp.user.id)
				.execute()
			expect(members).toHaveLength(0)

			const afterRes = await createSshKeyAs(cookie, afterKeyName)
			expect(afterRes.status, await afterRes.text()).toBe(401)

			const sshKeys = await db
				.selectFrom("sshKey")
				.select("id")
				.where("name", "in", [beforeKeyName, afterKeyName])
				.execute()
			expect(sshKeys).toHaveLength(0)
		} finally {
			await db.deleteFrom("sshKey").where("name", "in", [beforeKeyName, afterKeyName]).execute()
			await db.deleteFrom("member").where("userId", "=", signUp.user.id).execute()
			await db.deleteFrom("organization").where("slug", "=", slug).execute()
			await db.deleteFrom("session").where("userId", "=", signUp.user.id).execute()
			await db.deleteFrom("account").where("userId", "=", signUp.user.id).execute()
			await db.deleteFrom("user").where("id", "=", signUp.user.id).execute()
		}
	})
})

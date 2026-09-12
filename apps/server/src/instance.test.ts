import { randomUUID } from "node:crypto"
import { trpcServer } from "@hono/trpc-server"
import type {
	McpLoadedBot,
	McpPlayerStats,
	McpStatusEffect,
} from "@open-mcc/contracts/boundary/mcp-readouts"
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
	const secrets = await createSecretStore(await generateKeyPair("k1"))
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
				db,
				hostController: createHostController({
					hosts,
					sshKeys,
					secrets,
					probeHostKey: async () => Buffer.alloc(0),
					createTransport: () => createFakeTransport(),
					instanceIdsOnHost: async () => [],
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

const extractCookie = (res: Response): string =>
	res.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ")

let seededOrganizationIds: string[] = []
let seededEmails: string[] = []
let seededInstanceIds: string[] = []

afterEach(async () => {
	const organizationIds = seededOrganizationIds
	const emails = seededEmails
	const instanceIds = seededInstanceIds
	seededOrganizationIds = []
	seededEmails = []
	seededInstanceIds = []

	if (instanceIds.length > 0) {
		await db.deleteFrom("instanceConfig").where("instanceId", "in", instanceIds).execute()
		await db.deleteFrom("instance").where("id", "in", instanceIds).execute()
	}
	if (organizationIds.length > 0) {
		await db.deleteFrom("auditEvent").where("organizationId", "in", organizationIds).execute()
		await db.deleteFrom("instance").where("organizationId", "in", organizationIds).execute()
		await db.deleteFrom("host").where("organizationId", "in", organizationIds).execute()
		await db.deleteFrom("member").where("organizationId", "in", organizationIds).execute()
		await db.deleteFrom("organization").where("id", "in", organizationIds).execute()
	}
	if (emails.length > 0) {
		await db
			.deleteFrom("session")
			.where("userId", "in", (qb) =>
				qb.selectFrom("user").select("id").where("email", "in", emails),
			)
			.execute()
		await db
			.deleteFrom("account")
			.where("userId", "in", (qb) =>
				qb.selectFrom("user").select("id").where("email", "in", emails),
			)
			.execute()
		await db.deleteFrom("user").where("email", "in", emails).execute()
	}
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
		body: JSON.stringify({ email, password: "correct horse battery staple 1", name: "Inst Test" }),
	})
	expect(signUpRes.status).toBe(200)
	const cookie = extractCookie(signUpRes)

	const createOrgRes = await app.request("/api/auth/organization/create", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ name: "Inst Org", slug: `org-${randomUUID()}` }),
	})
	expect(createOrgRes.status).toBe(200)
	const org = orgResponseSchema.parse(await createOrgRes.json())
	seededOrganizationIds.push(org.id)

	await app.request("/api/auth/organization/set-active", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ organizationId: org.id }),
	})

	const member = await db
		.selectFrom("member")
		.select("id")
		.where("organizationId", "=", org.id)
		.executeTakeFirstOrThrow()

	return { cookie, orgId: org.id, memberId: member.id }
}

const demoteToRole = async (orgId: string, role: string): Promise<void> => {
	await db.updateTable("member").set({ role }).where("organizationId", "=", orgId).execute()
}

const seedInstance = async (orgId: string): Promise<string> => {
	const hostId = randomUUID()
	await db
		.insertInto("host")
		.values({ id: hostId, organizationId: orgId, name: `vps-${hostId}`, hostname: "10.0.0.1" })
		.execute()
	const instanceId = randomUUID()
	await db
		.insertInto("instance")
		.values({
			id: instanceId,
			organizationId: orgId,
			hostId,
			name: `afk-${instanceId.slice(0, 8)}`,
			minecraftAccount: "afk@example.com",
			minecraftUsername: null,
			liveControlPort: 48919,
			status: "stopped",
		})
		.execute()
	seededInstanceIds.push(instanceId)
	return instanceId
}

const call = async (
	path: string,
	cookie: string,
	input: Record<string, string | Record<string, string>>,
): Promise<Response> =>
	await app.request(`/trpc/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(input),
	})

describe("live reads with no channel", () => {
	it("answers with null rather than nothing, so the browser can cache the absence", async () => {
		const { cookie, orgId } = await signUpAndActivate()
		const instanceId = await seedInstance(orgId)

		const res = await app.request(
			`/trpc/instance.readLiveWorld?input=${encodeURIComponent(JSON.stringify({ instanceId }))}`,
			{ headers: { Origin: ORIGIN, Cookie: cookie } },
		)

		expect(res.status).toBe(200)
		const body = z.object({ result: z.object({ data: z.null() }) }).safeParse(await res.json())
		expect(body.success).toBe(true)
	})

	it.each(["readLivePlayerStats", "readLiveStatusEffects", "readLiveBots", "readLivePlayers"])(
		"answers %s with null rather than nothing",
		async (procedure) => {
			const { cookie, orgId } = await signUpAndActivate()
			const instanceId = await seedInstance(orgId)

			const res = await app.request(
				`/trpc/instance.${procedure}?input=${encodeURIComponent(JSON.stringify({ instanceId }))}`,
				{ headers: { Origin: ORIGIN, Cookie: cookie } },
			)

			expect(res.status).toBe(200)
			const body = z.object({ result: z.object({ data: z.null() }) }).safeParse(await res.json())
			expect(body.success).toBe(true)
		},
	)

	it("answers getConfig with null when the instance has no saved config", async () => {
		const { cookie, orgId } = await signUpAndActivate()
		const instanceId = await seedInstance(orgId)

		const res = await app.request(
			`/trpc/instance.getConfig?input=${encodeURIComponent(JSON.stringify({ instanceId }))}`,
			{ headers: { Origin: ORIGIN, Cookie: cookie } },
		)

		expect(res.status).toBe(200)
		const body = z.object({ result: z.object({ data: z.null() }) }).safeParse(await res.json())
		expect(body.success).toBe(true)
	})
})

describe("instance router capability boundaries", () => {
	it("refuses a viewer's attempt to start an instance, leaving its status unchanged", async () => {
		const { cookie, orgId } = await signUpAndActivate()
		const instanceId = await seedInstance(orgId)
		await demoteToRole(orgId, "viewer")

		const res = await call("instance.start", cookie, { instanceId })
		expect(res.status).toBe(403)
		const body = errorResponseSchema.parse(await res.json())
		expect(body.error.data.errorCode).toBe("FORBIDDEN")

		const after = await db
			.selectFrom("instance")
			.select("status")
			.where("id", "=", instanceId)
			.executeTakeFirstOrThrow()
		expect(after.status).toBe("stopped")
	})

	it("refuses an operator's attempt to authenticate, which binds a real microsoft account", async () => {
		const { cookie, orgId } = await signUpAndActivate()
		const instanceId = await seedInstance(orgId)
		await demoteToRole(orgId, "operator")

		const res = await call("instance.authenticate", cookie, { instanceId })
		expect(res.status).toBe(403)
	})

	it("refuses an operator's attempt to complete authentication, not just to begin it", async () => {
		const { cookie, orgId } = await signUpAndActivate()
		const instanceId = await seedInstance(orgId)
		await demoteToRole(orgId, "operator")

		const res = await call("instance.completeAuthentication", cookie, { instanceId })
		expect(res.status).toBe(403)
	})

	it("refuses an operator's attempt to create an instance", async () => {
		const { cookie, orgId } = await signUpAndActivate()
		await demoteToRole(orgId, "operator")

		const res = await call("instance.create", cookie, {
			hostId: randomUUID(),
			name: "afk-new",
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
		})
		expect(res.status).toBe(403)
	})

	it("refuses a viewer's console write while allowing an owner's", async () => {
		const { cookie, orgId } = await signUpAndActivate()
		const instanceId = await seedInstance(orgId)
		await demoteToRole(orgId, "viewer")

		const refused = await call("instance.sendCommand", cookie, { instanceId, command: "/say hi" })
		expect(refused.status).toBe(403)
	})

	it("★ refuses a viewer's attempt to save the client's bots, leaving nothing written", async () => {
		const { cookie, orgId } = await signUpAndActivate()
		const instanceId = await seedInstance(orgId)
		await demoteToRole(orgId, "viewer")

		const res = await call("instance.updateBotConfig", cookie, {
			instanceId,
			botConfig: { "ChatBot.Alerts.Enabled": "true" },
		})

		expect(res.status).toBe(403)
		const versions = await db
			.selectFrom("instanceConfig")
			.select("id")
			.where("instanceId", "=", instanceId)
			.execute()
		expect(versions).toEqual([])
	})

	it("★ refuses an instance belonging to another organization, before any write", async () => {
		const mine = await signUpAndActivate()
		const theirs = await signUpAndActivate()
		const instanceId = await seedInstance(theirs.orgId)

		const res = await call("instance.updateBotConfig", mine.cookie, {
			instanceId,
			botConfig: { "ChatBot.Alerts.Enabled": "true" },
		})

		expect(res.status).not.toBe(200)
		const versions = await db
			.selectFrom("instanceConfig")
			.select("id")
			.where("instanceId", "=", instanceId)
			.execute()
		expect(versions).toEqual([])
	})

	it("★ refuses a key the registry does not hold, so the strict schema reaches the wire", async () => {
		const { cookie, orgId } = await signUpAndActivate()
		const instanceId = await seedInstance(orgId)

		const res = await call("instance.updateBotConfig", cookie, {
			instanceId,
			botConfig: { "ChatBot.Script.Script_File": "evil" },
		})

		expect(res.status).toBe(400)
	})

	it("refuses an unauthenticated caller outright", async () => {
		const res = await app.request("/trpc/instance.list", {
			method: "GET",
			headers: { Origin: ORIGIN },
		})
		expect(res.status).toBe(401)
	})
})

describe("which controller method each readout route reaches", () => {
	const SENTINELS: {
		readLivePlayerStats: McpPlayerStats
		readLiveStatusEffects: McpStatusEffect[]
		readLiveBots: McpLoadedBot[]
		readLivePlayers: string[]
	} = {
		readLivePlayerStats: {
			health: 3,
			foodLevel: 4,
			level: 5,
			totalExperience: 6,
			gamemode: 2,
			currentSlot: 8,
			yaw: 9,
			pitch: 10,
			tps: 11,
		},
		readLiveStatusEffects: [
			{ id: "Glowing", amplifier: 1, remainingSeconds: 5, isInfinite: false },
		],
		readLiveBots: [{ name: "RouteSentinel", isScript: false }],
		readLivePlayers: ["RoutePlayer"],
	}

	const seen: Array<{ method: string; instanceId: string }> = []
	const refusedMethods = new Set<string>()
	let linked: Hono

	beforeAll(async () => {
		const auth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000", {
			trustedOrigins: [ORIGIN],
			disableSignUp: false,
			userCreation: "trusted",
			disableRateLimit: true,
			allowOrganizationCreation: true,
		})
		const secrets = await createSecretStore(await generateKeyPair("k2"))
		const hosts = createHostRepository(db)
		const sshKeys = createSshKeyRepository(db)
		const real = await createTestInstanceController(db)

		linked = new Hono()
		linked.use("*", requireSameOrigin([ORIGIN]))
		linked.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
		linked.use(
			"/trpc/*",
			trpcServer({
				router: appRouter,
				createContext: createRequestContext({
					auth,
					signupAuth: auth,
					db,
					hostController: createHostController({
						hosts,
						sshKeys,
						secrets,
						probeHostKey: async () => Buffer.alloc(0),
						createTransport: () => createFakeTransport(),
						instanceIdsOnHost: async () => [],
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
					instanceController: {
						...real,
						readLivePlayerStats: async (_actor, instanceId) => {
							if (refusedMethods.has("readLivePlayerStats"))
								throw new Error("readLivePlayerStats refused")
							seen.push({ method: "readLivePlayerStats", instanceId })
							return SENTINELS.readLivePlayerStats
						},
						readLiveStatusEffects: async (_actor, instanceId) => {
							if (refusedMethods.has("readLiveStatusEffects"))
								throw new Error("readLiveStatusEffects refused")
							seen.push({ method: "readLiveStatusEffects", instanceId })
							return SENTINELS.readLiveStatusEffects
						},
						readLiveBots: async (_actor, instanceId) => {
							if (refusedMethods.has("readLiveBots")) throw new Error("readLiveBots refused")
							seen.push({ method: "readLiveBots", instanceId })
							return SENTINELS.readLiveBots
						},
						readLivePlayers: async (_actor, instanceId) => {
							if (refusedMethods.has("readLivePlayers")) throw new Error("readLivePlayers refused")
							seen.push({ method: "readLivePlayers", instanceId })
							return SENTINELS.readLivePlayers
						},
					},
					statusController: createTestStatusController(db),
					destinationController: createTestDestinationController(db, secrets),
					sshKeyController: createSshKeyController({
						sshKeys,
						secrets,
						generateKeyPair: generateSshKeyPair,
						withTransaction: createSshKeyControllerTransaction(db),
					}),
				}),
			}),
		)
	})

	it.each([
		"readLivePlayerStats",
		"readLiveStatusEffects",
		"readLiveBots",
		"readLivePlayers",
	] as const)(
		"one failing readout leaves the other three routes answering, not %s alone",
		async (failing) => {
			const { cookie, orgId } = await signUpAndActivate()
			const instanceId = await seedInstance(orgId)
			refusedMethods.clear()
			refusedMethods.add(failing)

			const routes = [
				"readLivePlayerStats",
				"readLiveStatusEffects",
				"readLiveBots",
				"readLivePlayers",
			] as const
			const statuses = await Promise.all(
				routes.map(async (route) => {
					const res = await linked.request(
						`/trpc/instance.${route}?input=${encodeURIComponent(JSON.stringify({ instanceId }))}`,
						{ headers: { Origin: ORIGIN, Cookie: cookie } },
					)
					return { route, status: res.status }
				}),
			)
			refusedMethods.clear()

			expect(statuses.filter((entry) => entry.status === 200)).toHaveLength(3)
			expect(statuses.filter((entry) => entry.status !== 200).map((entry) => entry.route)).toEqual([
				failing,
			])
		},
	)

	it.each([
		"readLivePlayerStats",
		"readLiveStatusEffects",
		"readLiveBots",
		"readLivePlayers",
	] as const)(
		"route %s reaches that same controller method with the instance id",
		async (route) => {
			const { cookie, orgId } = await signUpAndActivate()
			const instanceId = await seedInstance(orgId)
			seen.length = 0

			const res = await linked.request(
				`/trpc/instance.${route}?input=${encodeURIComponent(JSON.stringify({ instanceId }))}`,
				{ headers: { Origin: ORIGIN, Cookie: cookie } },
			)

			expect(res.status).toBe(200)
			expect(seen).toEqual([{ method: route, instanceId }])
			expect(await res.json()).toMatchObject({ result: { data: SENTINELS[route] } })
		},
	)
})

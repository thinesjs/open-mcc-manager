import { randomUUID } from "node:crypto"
import { trpcServer } from "@hono/trpc-server"
import { instancePublic } from "@open-mcc/contracts"
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
	type SecretStore,
	startUnitCommand,
} from "@open-mcc/core"
import { createDb, type Db, type JsonObject } from "@open-mcc/db"
import { createFakeTransport, type FakeScript } from "@open-mcc/transport"
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
const hostScript: FakeScript = {}

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
	secrets = await createSecretStore(await generateKeyPair("instancepublicsealbox"))
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
					evictHost: () => undefined,
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
				instanceController: await createTestInstanceController(db, secrets, hostScript),
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
		await db.deleteFrom("instanceConfig").where("organizationId", "in", organizationIds).execute()
		await db.deleteFrom("instance").where("organizationId", "in", organizationIds).execute()
		await db.deleteFrom("host").where("organizationId", "in", organizationIds).execute()
		await db.deleteFrom("sshKey").where("organizationId", "in", organizationIds).execute()
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

const call = async (path: string, cookie: string, input: JsonObject): Promise<Response> =>
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

	it("says the live view is not available when a drop has no channel to go through", async () => {
		const { cookie, orgId } = await signUpAndActivate()
		const instanceId = await seedInstance(orgId)

		const res = await call("instance.dropInventoryItem", cookie, {
			instanceId,
			itemType: "Diamond",
			count: 1,
		})
		const body = await res.text()

		expect(res.status).toBe(409)
		expect(body).toContain("INSTANCE_LIVE_UNAVAILABLE")
		expect(body).not.toContain("Internal server error")
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
			advancedKeys: {},
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
			advancedKeys: {},
		})

		expect(res.status).not.toBe(200)
		const versions = await db
			.selectFrom("instanceConfig")
			.select("id")
			.where("instanceId", "=", instanceId)
			.execute()
		expect(versions).toEqual([])
	})

	it("★ lets a settings save without advanced keys reach the controller, which is now the only shape", async () => {
		const { cookie, orgId } = await signUpAndActivate()
		const instanceId = await seedInstance(orgId)

		const res = await call("instance.updateConfig", cookie, {
			instanceId,
			config: {
				accountType: "offline",
				minecraftAccount: "OpenMccBot",
				serverAddress: "play.example.com",
				autoRelogRetries: 3,
				autoRelogEnabled: true,
				autoRelogDelaySeconds: { min: 5, max: 20 },
				antiAfkEnabled: true,
				antiAfkIntervalSeconds: { min: 90, max: 300 },
			},
		})

		const body = await res.text()
		expect(body).not.toContain("unrecognized_keys")
		expect(body).toContain("INSTANCE_HOST_NOT_READY")
	})

	it("★ refuses a settings save that tries to carry the advanced keys, which now travel with the bots", async () => {
		const { cookie, orgId } = await signUpAndActivate()
		const instanceId = await seedInstance(orgId)

		const res = await call("instance.updateConfig", cookie, {
			instanceId,
			config: {
				accountType: "offline",
				minecraftAccount: "OpenMccBot",
				serverAddress: "play.example.com",
				autoRelogRetries: 3,
				autoRelogEnabled: true,
				autoRelogDelaySeconds: { min: 5, max: 20 },
				antiAfkEnabled: true,
				antiAfkIntervalSeconds: { min: 90, max: 300 },
				advancedKeys: { "ChatBot.AutoEat.Enabled": "true" },
			},
		})

		expect(res.status).toBe(400)
		const body = await res.text()
		expect(body).toContain("Check what you entered and try again.")
		expect(body).not.toContain("unrecognized_keys")
		expect(body).not.toContain("advancedKeys")
	})

	it("★ refuses a key the registry does not hold, so the strict schema reaches the wire", async () => {
		const { cookie, orgId } = await signUpAndActivate()
		const instanceId = await seedInstance(orgId)

		const res = await call("instance.updateBotConfig", cookie, {
			instanceId,
			botConfig: { "ChatBot.Script.Script_File": "evil" },
			advancedKeys: {},
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
						evictHost: () => undefined,
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
					selfHostController: createTestSelfHostController(db),
					memberController: memberControllerFor(db, auth, () => undefined),
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

const SEALED_TOKEN_SENTINEL = "sealed-live-control-token-sentinel"
const TOKEN_KEY_SENTINEL = "sealed-token-key-id-sentinel"
const AUTH_CLAIM_SENTINEL = "auth-claim-id-sentinel"

const WITHHELD_INSTANCE_FIELDS = [
	"liveControlTokenEncrypted",
	"liveControlTokenKeyId",
	"authClaimId",
	"authClaimedAt",
	"organizationId",
]

const PUBLIC_INSTANCE_FIELDS = Object.keys(instancePublic.shape).sort()

const shownResponseSchema = z.object({
	result: z.object({
		data: z.union([z.array(z.object({}).passthrough()), z.object({}).passthrough()]),
	}),
})

const shownEntries = (text: string) => {
	const data = shownResponseSchema.parse(JSON.parse(text)).result.data
	return Array.isArray(data) ? data : [data]
}

const seedReadyInstance = async (
	orgId: string,
	memberId: string,
): Promise<{ hostId: string; instanceId: string }> => {
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
			hostname: "10.0.0.1",
			status: "ready",
			osRelease: "systemd 252",
			networkStack: "slirp4netns",
			architecture: "x64",
			sshKeyId,
			hostKeyAlgorithm: "ssh-ed25519",
			hostKeyFingerprint: "SHA256:instancepublicIJKLMNOPQRSTUVWXYZabcdefghijk",
			hostKeyTrustedBy: memberId,
			hostKeyTrustedByLabel: "seed@example.com",
			hostKeyTrustedAt: new Date(),
		})
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
			liveControlTokenEncrypted: SEALED_TOKEN_SENTINEL,
			liveControlTokenKeyId: TOKEN_KEY_SENTINEL,
			authClaimId: AUTH_CLAIM_SENTINEL,
			authClaimedAt: new Date(),
			status: "stopped",
		})
		.execute()
	seededInstanceIds.push(instanceId)
	hostScript[startUnitCommand(instanceId)] = {
		stdout: "ActiveState=active\nResult=success\nSignIn=inactive\n",
		stderr: "",
		exitCode: 0,
	}
	return { hostId, instanceId }
}

const readInstance = async (cookie: string, instanceId: string): Promise<Response> =>
	await app.request(
		`/trpc/instance.get?input=${encodeURIComponent(JSON.stringify({ instanceId }))}`,
		{
			headers: { Origin: ORIGIN, Cookie: cookie },
		},
	)

const INSTANCE_PROCEDURES = [
	{
		procedure: "list",
		role: "viewer",
		send: (cookie: string) =>
			app.request("/trpc/instance.list", { headers: { Origin: ORIGIN, Cookie: cookie } }),
	},
	{
		procedure: "get",
		role: "viewer",
		send: (cookie: string, seeded: { instanceId: string }) =>
			readInstance(cookie, seeded.instanceId),
	},
	{
		procedure: "create",
		role: "owner",
		send: (cookie: string, seeded: { hostId: string }) =>
			call("instance.create", cookie, {
				hostId: seeded.hostId,
				name: "public-shape-bot",
				accountType: "offline",
				minecraftAccount: "PublicShapeBot",
				serverAddress: "play.example.com",
			}),
	},
	{
		procedure: "start",
		role: "owner",
		send: (cookie: string, seeded: { instanceId: string }) =>
			call("instance.start", cookie, { instanceId: seeded.instanceId }),
	},
	{
		procedure: "restart",
		role: "owner",
		send: (cookie: string, seeded: { instanceId: string }) =>
			call("instance.restart", cookie, { instanceId: seeded.instanceId }),
	},
	{
		procedure: "stop",
		role: "owner",
		send: (cookie: string, seeded: { instanceId: string }) =>
			call("instance.stop", cookie, { instanceId: seeded.instanceId }),
	},
]

describe("what an instance procedure sends the browser", () => {
	it.each(INSTANCE_PROCEDURES)(
		"★ instance.$procedure hands a $role exactly the public instance fields",
		async ({ role, send }) => {
			const { cookie, orgId, memberId } = await signUpAndActivate()
			const seeded = await seedReadyInstance(orgId, memberId)
			await demoteToRole(orgId, role)

			const res = await send(cookie, seeded)
			const text = await res.text()
			expect(res.status, text).toBe(200)

			const entries = shownEntries(text)
			expect(entries.length).toBeGreaterThan(0)
			for (const entry of entries) {
				expect(Object.keys(entry).sort()).toEqual(PUBLIC_INSTANCE_FIELDS)
			}
		},
	)

	it.each(INSTANCE_PROCEDURES)(
		"★ instance.$procedure never carries the sealed live control token, its key or the sign-in claim",
		async ({ role, send }) => {
			const { cookie, orgId, memberId } = await signUpAndActivate()
			const seeded = await seedReadyInstance(orgId, memberId)
			await demoteToRole(orgId, role)

			const res = await send(cookie, seeded)
			const text = await res.text()
			expect(res.status, text).toBe(200)

			for (const field of WITHHELD_INSTANCE_FIELDS) {
				expect(PUBLIC_INSTANCE_FIELDS).not.toContain(field)
				for (const entry of shownEntries(text)) {
					expect(Object.keys(entry)).not.toContain(field)
				}
			}

			const stored = await db
				.selectFrom("instance")
				.select([
					"liveControlTokenEncrypted",
					"liveControlTokenKeyId",
					"authClaimId",
					"organizationId",
				])
				.where("organizationId", "=", orgId)
				.execute()
			const withheldValues = stored
				.flatMap((row) => [
					row.liveControlTokenEncrypted,
					row.liveControlTokenKeyId,
					row.authClaimId,
					row.organizationId,
				])
				.filter((value) => value !== null)
			expect(withheldValues.length).toBeGreaterThan(0)
			for (const value of withheldValues) {
				expect(text).not.toContain(value)
			}
		},
	)

	it("★ a refused start names nothing the instance withholds", async () => {
		const { cookie, orgId, memberId } = await signUpAndActivate()
		const { instanceId } = await seedReadyInstance(orgId, memberId)
		await db
			.updateTable("instance")
			.set({ status: "needs_auth" })
			.where("id", "=", instanceId)
			.execute()

		const res = await call("instance.start", cookie, { instanceId })
		const text = await res.text()
		expect(res.status, text).toBe(409)

		for (const value of [SEALED_TOKEN_SENTINEL, TOKEN_KEY_SENTINEL, AUTH_CLAIM_SENTINEL, orgId]) {
			expect(text).not.toContain(value)
		}
		for (const field of WITHHELD_INSTANCE_FIELDS) {
			expect(text).not.toContain(field)
		}
	})
})

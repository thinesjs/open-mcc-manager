import { randomUUID } from "node:crypto"
import { trpcServer } from "@hono/trpc-server"
import {
	acceptInvitationResultSchema,
	pendingInvitationSchema,
	type Role,
} from "@open-mcc/contracts"
import {
	createHostController,
	createHostControllerTransaction,
	createHostRepository,
	createMemberRepository,
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
const FINGERPRINT = "SHA256:keptIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstu"

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
					hosts: createHostRepository(db),
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
			}),
		}),
	)
})

afterAll(async () => {
	await db.destroy()
})

const orgResponseSchema = z.object({ id: z.string() })
const invitationResultSchema = z.object({
	result: z.object({ data: z.object({ id: z.string() }) }),
})
const booleanResultSchema = z.object({ result: z.object({ data: z.boolean() }) })
const membersResultSchema = z.object({
	result: z.object({
		data: z.array(z.object({ email: z.string(), role: z.string(), self: z.boolean() })),
	}),
})
const invitationsResultSchema = z.object({
	result: z.object({ data: z.array(z.object({ id: z.string(), email: z.string() })) }),
})
const scalarDataSchema = z.object({
	result: z.object({
		data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
	}),
})
const dataOf = (body: string) => scalarDataSchema.parse(JSON.parse(body)).result.data
const errorCodeSchema = z.object({
	error: z.object({ data: z.object({ errorCode: z.string().optional() }) }),
})
const sessionSchema = z
	.object({ session: z.object({ activeOrganizationId: z.string().nullable() }) })
	.nullable()

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

const deleteSeededRows = async (organizationIds: string[], emails: string[]): Promise<void> => {
	if (organizationIds.length > 0) {
		await db.deleteFrom("instanceConfig").where("organizationId", "in", organizationIds).execute()
		await db.deleteFrom("instance").where("organizationId", "in", organizationIds).execute()
		await db.deleteFrom("host").where("organizationId", "in", organizationIds).execute()
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
	const organizationIds = seededOrganizationIds
	const emails = seededEmails
	seededOrganizationIds = []
	seededEmails = []
	await deleteSeededRows(organizationIds, emails)
})

const post = (path: string, cookie: string, body: object): Promise<Response> =>
	Promise.resolve(
		app.request(path, {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify(body),
		}),
	)

const get = (path: string, cookie: string): Promise<Response> =>
	Promise.resolve(app.request(path, { method: "GET", headers: { Origin: ORIGIN, Cookie: cookie } }))

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
		name: "Members Org",
		slug: `org-${randomUUID()}`,
	})
	expect(res.status).toBe(200)
	const org = orgResponseSchema.parse(await res.json())
	seededOrganizationIds.push(org.id)
	await activate(person.cookie, org.id)
	const member = await db
		.selectFrom("member")
		.select("id")
		.where("organizationId", "=", org.id)
		.where("userId", "=", person.userId)
		.executeTakeFirstOrThrow()
	return { ...person, orgId: org.id, memberId: member.id }
}

const joinAs = async (organizationId: string, role: Role) => {
	const person = await signUp(role)
	const memberId = randomUUID()
	await db
		.insertInto("member")
		.values({ id: memberId, organizationId, userId: person.userId, role })
		.execute()
	await activate(person.cookie, organizationId)
	return { ...person, memberId }
}

const isMember = async (memberId: string): Promise<boolean> =>
	(await db.selectFrom("member").select("id").where("id", "=", memberId).execute()).length === 1

const sessionOf = async (cookie: string) =>
	sessionSchema.parse(await (await get("/api/auth/get-session", cookie)).json())

const invite = async (cookie: string, role: Role): Promise<string> => {
	const res = await post("/trpc/member.invite", cookie, { email: seededEmail(), role })
	const body = await res.text()
	expect(res.status, body).toBe(200)
	return invitationResultSchema.parse(JSON.parse(body)).result.data.id
}

const statusOf = async (invitationId: string): Promise<string | undefined> =>
	(
		await db
			.selectFrom("invitation")
			.select("status")
			.where("id", "=", invitationId)
			.executeTakeFirst()
	)?.status

describe("member.remove", () => {
	it("removes a member, records who did it, and signs them out of this organization at once", async () => {
		const owner = await signUpOwner()
		const operator = await joinAs(owner.orgId, "operator")
		expect((await get("/trpc/member.me", operator.cookie)).status).toBe(200)

		const res = await post("/trpc/member.remove", owner.cookie, { memberId: operator.memberId })
		const body = await res.text()
		expect(res.status, body).toBe(200)
		expect(booleanResultSchema.parse(JSON.parse(body)).result.data).toBe(true)

		expect(await isMember(operator.memberId)).toBe(false)
		const audit = await db
			.selectFrom("auditEvent")
			.select(["actorId", "actorLabel", "detail"])
			.where("organizationId", "=", owner.orgId)
			.where("action", "=", "member.remove")
			.where("subjectId", "=", operator.memberId)
			.executeTakeFirst()
		expect(audit?.actorId).toBe(owner.memberId)
		expect(audit?.actorLabel).toBe(owner.email)
		expect(audit?.detail).toMatchObject({ email: operator.email, role: "operator" })

		expect((await get("/trpc/member.me", operator.cookie)).status).toBe(401)
		expect(await sessionOf(operator.cookie)).toBeNull()
	})

	it("leaves the same person signed in to another organization they still belong to", async () => {
		const owner = await signUpOwner()
		const elsewhere = await signUpOwner()
		const memberId = randomUUID()
		await db
			.insertInto("member")
			.values({
				id: memberId,
				organizationId: owner.orgId,
				userId: elsewhere.userId,
				role: "operator",
			})
			.execute()
		const signIn = await post("/api/auth/sign-in/email", "", {
			email: elsewhere.email,
			password: PASSWORD,
		})
		expect(signIn.status).toBe(200)
		const sessionHere = extractCookie(signIn)
		await activate(sessionHere, owner.orgId)

		const res = await post("/trpc/member.remove", owner.cookie, { memberId })
		expect(res.status, await res.text()).toBe(200)

		expect(await sessionOf(sessionHere)).toBeNull()
		expect((await sessionOf(elsewhere.cookie))?.session.activeOrganizationId).toBe(elsewhere.orgId)
		expect((await get("/trpc/member.me", elsewhere.cookie)).status).toBe(200)
		expect(
			await db.selectFrom("user").select("id").where("id", "=", elsewhere.userId).execute(),
		).toHaveLength(1)
	})

	it("refuses someone who cannot manage members, and removes no one", async () => {
		const owner = await signUpOwner()
		const operator = await joinAs(owner.orgId, "operator")
		const viewer = await joinAs(owner.orgId, "viewer")

		const res = await post("/trpc/member.remove", operator.cookie, { memberId: viewer.memberId })
		const body = await res.text()
		expect(res.status, body).toBe(403)

		expect(await isMember(viewer.memberId)).toBe(true)
		expect((await get("/trpc/member.me", viewer.cookie)).status).toBe(200)
	})

	it("refuses an owner removing themselves, so the owners left are ones who can still sign in", async () => {
		const owner = await signUpOwner()
		await joinAs(owner.orgId, "owner")

		const res = await post("/trpc/member.remove", owner.cookie, { memberId: owner.memberId })
		expect(res.status, await res.text()).toBe(403)

		expect(await isMember(owner.memberId)).toBe(true)
		expect((await get("/trpc/member.me", owner.cookie)).status).toBe(200)
	})

	it("lets an owner remove another owner", async () => {
		const owner = await signUpOwner()
		const second = await joinAs(owner.orgId, "owner")

		const res = await post("/trpc/member.remove", owner.cookie, { memberId: second.memberId })
		expect(res.status, await res.text()).toBe(200)

		expect((await get("/trpc/member.me", second.cookie)).status).toBe(401)
	})

	it("keeps one owner when two owners remove each other at once", async () => {
		const first = await signUpOwner()
		const second = await joinAs(first.orgId, "owner")
		const scope = { organizationId: first.orgId }

		let racing: Promise<Response[]> | undefined
		await db.transaction().execute(async (tx) => {
			await createMemberRepository(tx).lock(scope)
			racing = Promise.all([
				post("/trpc/member.remove", first.cookie, { memberId: second.memberId }),
				post("/trpc/member.remove", second.cookie, { memberId: first.memberId }),
			])
			await new Promise((resolve) => setTimeout(resolve, 1_000))
		})
		const responses = await (racing ?? Promise.resolve([]))

		expect(responses.map((res) => res.status).sort()).toEqual([200, 403])
		const owners = await db
			.selectFrom("member")
			.select("id")
			.where("organizationId", "=", first.orgId)
			.where("role", "=", "owner")
			.execute()
		expect(owners).toHaveLength(1)
	})

	it("keeps what the removed member did, under the name they did it with", async () => {
		const owner = await signUpOwner()
		const leaver = await joinAs(owner.orgId, "owner")
		const hostId = randomUUID()
		await db
			.insertInto("host")
			.values({
				id: hostId,
				organizationId: owner.orgId,
				name: `vps-${hostId}`,
				hostname: "10.0.0.42",
				hostKeyFingerprint: FINGERPRINT,
				hostKeyAlgorithm: "ssh-ed25519",
				hostKeyTrustedBy: leaver.memberId,
				hostKeyTrustedByLabel: leaver.email,
				hostKeyTrustedAt: new Date(),
			})
			.execute()
		const instanceId = randomUUID()
		await db
			.insertInto("instance")
			.values({
				id: instanceId,
				organizationId: owner.orgId,
				hostId,
				name: `bot-${instanceId}`,
				minecraftAccount: "OpenMccBot",
				liveControlPort: 40_001,
			})
			.execute()
		await db
			.insertInto("instanceConfig")
			.values({
				id: randomUUID(),
				organizationId: owner.orgId,
				instanceId,
				version: 1,
				document: { serverAddress: "play.example.com" },
				authorId: leaver.memberId,
				authorLabel: leaver.email,
			})
			.execute()
		await db
			.insertInto("auditEvent")
			.values({
				id: randomUUID(),
				organizationId: owner.orgId,
				actorId: leaver.memberId,
				actorLabel: leaver.email,
				action: "host.enroll",
				subjectType: "host",
				subjectId: hostId,
				detail: {},
			})
			.execute()

		const res = await post("/trpc/member.remove", owner.cookie, { memberId: leaver.memberId })
		expect(res.status, await res.text()).toBe(200)

		expect(
			await db
				.selectFrom("host")
				.select(["hostKeyTrustedBy", "hostKeyTrustedByLabel", "hostKeyFingerprint"])
				.where("id", "=", hostId)
				.executeTakeFirst(),
		).toEqual({
			hostKeyTrustedBy: null,
			hostKeyTrustedByLabel: leaver.email,
			hostKeyFingerprint: FINGERPRINT,
		})
		expect(
			await db
				.selectFrom("instanceConfig")
				.select(["authorId", "authorLabel"])
				.where("instanceId", "=", instanceId)
				.executeTakeFirst(),
		).toEqual({ authorId: null, authorLabel: leaver.email })
		expect(
			await db
				.selectFrom("auditEvent")
				.select(["actorId", "actorLabel"])
				.where("organizationId", "=", owner.orgId)
				.where("action", "=", "host.enroll")
				.executeTakeFirst(),
		).toEqual({ actorId: null, actorLabel: leaver.email })

		const hosts = await get("/trpc/host.list", owner.cookie)
		const hostsBody = await hosts.text()
		expect(hosts.status, hostsBody).toBe(200)
		expect(hostsBody).toContain(leaver.email)
		expect(
			await db.selectFrom("user").select("id").where("email", "=", leaver.email).execute(),
		).toEqual([])
	})

	it("cancels the invitations a removed owner sent, so they cannot come back through one", async () => {
		const owner = await signUpOwner()
		const leaver = await joinAs(owner.orgId, "owner")
		const planted = await invite(leaver.cookie, "owner")
		const ownersOwn = await invite(owner.cookie, "viewer")

		const res = await post("/trpc/member.remove", owner.cookie, { memberId: leaver.memberId })
		expect(res.status, await res.text()).toBe(200)

		const audit = await db
			.selectFrom("auditEvent")
			.select("detail")
			.where("action", "=", "member.remove")
			.where("subjectId", "=", leaver.memberId)
			.executeTakeFirst()
		expect(audit?.detail).toMatchObject({ invitationsCancelled: "1" })
		expect(await statusOf(planted)).toBeUndefined()
		expect(await statusOf(ownersOwn)).toBe("pending")
		const accept = await post("/trpc/member.acceptInvitation", "", {
			invitationId: planted,
			password: PASSWORD,
			name: "Returning",
		})
		expect(accept.status).toBe(400)
	})

	it("does not reach into another organization", async () => {
		const owner = await signUpOwner()
		const stranger = await signUpOwner()
		const operator = await joinAs(owner.orgId, "operator")
		const invitation = await invite(owner.cookie, "viewer")

		const remove = await post("/trpc/member.remove", stranger.cookie, {
			memberId: operator.memberId,
		})
		const removeBody = await remove.text()
		expect(remove.status, removeBody).toBe(200)
		expect(booleanResultSchema.parse(JSON.parse(removeBody)).result.data).toBe(false)
		expect(await isMember(operator.memberId)).toBe(true)
		expect((await get("/trpc/member.me", operator.cookie)).status).toBe(200)

		const cancel = await post("/trpc/member.cancelInvitation", stranger.cookie, {
			invitationId: invitation,
		})
		const cancelBody = await cancel.text()
		expect(cancel.status, cancelBody).toBe(200)
		expect(booleanResultSchema.parse(JSON.parse(cancelBody)).result.data).toBe(false)
		expect(await statusOf(invitation)).toBe("pending")

		const list = await get("/trpc/member.list", stranger.cookie)
		const listBody = await list.text()
		expect(list.status, listBody).toBe(200)
		expect(membersResultSchema.parse(JSON.parse(listBody)).result.data).toEqual([
			{ email: stranger.email, role: "owner", self: true },
		])
	})

	it("refuses an owner whose own removal committed while their request waited for the lock", async () => {
		const first = await signUpOwner()
		const second = await joinAs(first.orgId, "owner")
		const third = await joinAs(first.orgId, "owner")
		const scope = { organizationId: first.orgId }

		let pending: Promise<Response> | undefined
		await db.transaction().execute(async (tx) => {
			const members = createMemberRepository(tx)
			await members.lock(scope)
			await members.delete(scope, second.memberId)
			pending = post("/trpc/member.remove", second.cookie, { memberId: third.memberId })
			await new Promise((resolve) => setTimeout(resolve, 1_000))
		})
		const res = await (pending ?? Promise.reject(new Error("the removal was never sent")))

		expect(res.status, await res.text()).toBe(403)
		expect(await isMember(third.memberId)).toBe(true)
		expect((await get("/trpc/member.me", third.cookie)).status).toBe(200)
	})

	it("lets a removed member come back through a new invitation", async () => {
		const owner = await signUpOwner()
		const operator = await joinAs(owner.orgId, "operator")
		const removed = await post("/trpc/member.remove", owner.cookie, {
			memberId: operator.memberId,
		})
		expect(removed.status, await removed.text()).toBe(200)

		const inviteRes = await post("/trpc/member.invite", owner.cookie, {
			email: operator.email,
			role: "viewer",
		})
		const inviteBody = await inviteRes.text()
		expect(inviteRes.status, inviteBody).toBe(200)
		const invitationId = invitationResultSchema.parse(JSON.parse(inviteBody)).result.data.id

		const accept = await post("/trpc/member.acceptInvitation", "", {
			invitationId,
			password: "a brand new password 2",
			name: "Back Again",
		})
		expect(accept.status, await accept.text()).toBe(200)

		const signIn = await post("/api/auth/sign-in/email", "", {
			email: operator.email,
			password: "a brand new password 2",
		})
		expect(signIn.status).toBe(200)
		expect(
			await db
				.selectFrom("member")
				.innerJoin("user", "user.id", "member.userId")
				.select("member.role")
				.where("member.organizationId", "=", owner.orgId)
				.where("user.email", "=", operator.email)
				.execute(),
		).toEqual([{ role: "viewer" }])
	})
})

describe("member.acceptInvitation", () => {
	it("says an invited email already has an account when that person still belongs to another organization", async () => {
		const owner = await signUpOwner()
		const elsewhere = await signUpOwner()
		const inviteRes = await post("/trpc/member.invite", owner.cookie, {
			email: elsewhere.email,
			role: "viewer",
		})
		const inviteBody = await inviteRes.text()
		expect(inviteRes.status, inviteBody).toBe(200)
		const invitationId = invitationResultSchema.parse(JSON.parse(inviteBody)).result.data.id

		const accept = await post("/trpc/member.acceptInvitation", "", {
			invitationId,
			password: "someone else's guess 3",
			name: "Not Them",
		})
		const body = await accept.text()

		expect(accept.status, body).toBe(409)
		expect(errorCodeSchema.parse(JSON.parse(body)).error.data.errorCode).toBe(
			"INVITATION_EMAIL_HAS_ACCOUNT",
		)
		expect(await statusOf(invitationId)).toBe("pending")
		expect((await get("/trpc/member.me", elsewhere.cookie)).status).toBe(200)
	})

	it("refuses an invitation whose inviter is no longer a member, even when it is still pending", async () => {
		const owner = await signUpOwner()
		const inviter = await signUpOwner()
		const inviterMemberId = randomUUID()
		await db
			.insertInto("member")
			.values({
				id: inviterMemberId,
				organizationId: owner.orgId,
				userId: inviter.userId,
				role: "owner",
			})
			.execute()
		const signIn = await post("/api/auth/sign-in/email", "", {
			email: inviter.email,
			password: PASSWORD,
		})
		expect(signIn.status).toBe(200)
		const inviterHere = extractCookie(signIn)
		await activate(inviterHere, owner.orgId)
		const planted = await invite(inviterHere, "owner")

		const removed = await post("/trpc/member.remove", owner.cookie, { memberId: inviterMemberId })
		expect(removed.status, await removed.text()).toBe(200)
		await db
			.updateTable("invitation")
			.set({ status: "pending" })
			.where("id", "=", planted)
			.execute()

		const plantedEmail = (
			await db
				.selectFrom("invitation")
				.select("email")
				.where("id", "=", planted)
				.executeTakeFirstOrThrow()
		).email
		const accept = await post("/trpc/member.acceptInvitation", "", {
			invitationId: planted,
			password: PASSWORD,
			name: "Planted",
		})
		const body = await accept.text()

		expect(accept.status, body).toBe(400)
		expect(errorCodeSchema.parse(JSON.parse(body)).error.data.errorCode).toBe(
			"INVITATION_NOT_FOUND",
		)
		expect(
			await db
				.selectFrom("member")
				.innerJoin("user", "user.id", "member.userId")
				.select("member.id")
				.where("member.organizationId", "=", owner.orgId)
				.where("user.email", "=", plantedEmail)
				.execute(),
		).toEqual([])
		expect(
			await db.selectFrom("user").select("id").where("email", "=", plantedEmail).execute(),
		).toEqual([])
	})

	it("deletes the account an accept created when its invitation was cancelled mid-accept", async () => {
		const owner = await signUpOwner()
		const invitationId = await invite(owner.cookie, "operator")
		const invitedEmail = (
			await db
				.selectFrom("invitation")
				.select("email")
				.where("id", "=", invitationId)
				.executeTakeFirstOrThrow()
		).email

		let pending: Promise<Response> | undefined
		await db.transaction().execute(async (tx) => {
			await tx
				.updateTable("invitation")
				.set({ status: "canceled" })
				.where("id", "=", invitationId)
				.execute()
			pending = post("/trpc/member.acceptInvitation", "", {
				invitationId,
				password: PASSWORD,
				name: "Cancelled Midway",
			})
			await new Promise((resolve) => setTimeout(resolve, 1_500))
		})
		const accept = await (pending ?? Promise.reject(new Error("the accept was never sent")))
		const body = await accept.text()

		expect(accept.status, body).toBe(400)
		expect(errorCodeSchema.parse(JSON.parse(body)).error.data.errorCode).toBe(
			"INVITATION_NOT_FOUND",
		)
		expect(await statusOf(invitationId)).toBe("canceled")
		expect(
			await db.selectFrom("user").select("id").where("email", "=", invitedEmail).execute(),
		).toEqual([])
	})
})

describe("member.cancelInvitation", () => {
	it("cancels a waiting invitation, records it, and the link stops working", async () => {
		const owner = await signUpOwner()
		const invitation = await invite(owner.cookie, "operator")

		const res = await post("/trpc/member.cancelInvitation", owner.cookie, {
			invitationId: invitation,
		})
		const body = await res.text()
		expect(res.status, body).toBe(200)
		expect(booleanResultSchema.parse(JSON.parse(body)).result.data).toBe(true)

		expect(await statusOf(invitation)).toBe("canceled")
		const audit = await db
			.selectFrom("auditEvent")
			.select("actorLabel")
			.where("action", "=", "member.invite.cancel")
			.where("subjectId", "=", invitation)
			.executeTakeFirst()
		expect(audit?.actorLabel).toBe(owner.email)

		const accept = await post("/trpc/member.acceptInvitation", "", {
			invitationId: invitation,
			password: PASSWORD,
			name: "Too Late",
		})
		const acceptBody = await accept.text()
		expect(accept.status, acceptBody).toBe(400)
		expect(errorCodeSchema.parse(JSON.parse(acceptBody)).error.data.errorCode).toBe(
			"INVITATION_NOT_FOUND",
		)
	})

	it("refuses someone who cannot manage members", async () => {
		const owner = await signUpOwner()
		const viewer = await joinAs(owner.orgId, "viewer")
		const invitation = await invite(owner.cookie, "operator")

		const res = await post("/trpc/member.cancelInvitation", viewer.cookie, {
			invitationId: invitation,
		})
		expect(res.status, await res.text()).toBe(403)
		expect(await statusOf(invitation)).toBe("pending")
	})
})

describe("member.list and member.invitations", () => {
	it("shows an owner everyone, marking their own row, and only the invitations still waiting", async () => {
		const owner = await signUpOwner()
		const operator = await joinAs(owner.orgId, "operator")
		const waiting = await invite(owner.cookie, "viewer")
		const cancelled = await invite(owner.cookie, "viewer")
		expect(
			(await post("/trpc/member.cancelInvitation", owner.cookie, { invitationId: cancelled }))
				.status,
		).toBe(200)

		const members = await get("/trpc/member.list", owner.cookie)
		const membersBody = await members.text()
		expect(members.status, membersBody).toBe(200)
		const byEmail = (a: { email: string }, b: { email: string }) => (a.email < b.email ? -1 : 1)
		expect(membersResultSchema.parse(JSON.parse(membersBody)).result.data.sort(byEmail)).toEqual(
			[
				{ email: owner.email, role: "owner", self: true },
				{ email: operator.email, role: "operator", self: false },
			].sort(byEmail),
		)

		const invitations = await get("/trpc/member.invitations", owner.cookie)
		const invitationsBody = await invitations.text()
		expect(invitations.status, invitationsBody).toBe(200)
		expect(
			invitationsResultSchema.parse(JSON.parse(invitationsBody)).result.data.map((row) => row.id),
		).toEqual([waiting])
	})

	it("refuses both lists to someone who cannot manage members", async () => {
		const owner = await signUpOwner()
		const operator = await joinAs(owner.orgId, "operator")

		expect((await get("/trpc/member.list", operator.cookie)).status).toBe(403)
		expect((await get("/trpc/member.invitations", operator.cookie)).status).toBe(403)
	})
})

describe("member.invite", () => {
	it("says the person is already invited or already a member, rather than failing as an internal error", async () => {
		const owner = await signUpOwner()
		const operator = await joinAs(owner.orgId, "operator")
		const email = seededEmail()
		expect(
			(await post("/trpc/member.invite", owner.cookie, { email, role: "viewer" })).status,
		).toBe(200)

		for (const repeated of [email, operator.email]) {
			const res = await post("/trpc/member.invite", owner.cookie, {
				email: repeated,
				role: "viewer",
			})
			const body = await res.text()
			expect(res.status, body).toBe(409)
			expect(errorCodeSchema.parse(JSON.parse(body)).error.data.errorCode).toBe(
				"MEMBER_ALREADY_INVITED",
			)
		}
	})
})

describe("what the invitation procedures hand back", () => {
	it("gives the inviting owner only the fields the invitation contract names", async () => {
		const owner = await signUpOwner()

		const res = await post("/trpc/member.invite", owner.cookie, {
			email: seededEmail(),
			role: "viewer",
		})
		const body = await res.text()
		expect(res.status, body).toBe(200)

		expect(Object.keys(dataOf(body)).sort()).toEqual(
			Object.keys(pendingInvitationSchema.shape).sort(),
		)
	})

	it("tells a caller who is not signed in only that the invitation was accepted", async () => {
		const owner = await signUpOwner()
		const invitationId = await invite(owner.cookie, "viewer")

		const res = await post("/trpc/member.acceptInvitation", "", {
			invitationId,
			password: PASSWORD,
			name: "Joiner",
		})
		const body = await res.text()
		expect(res.status, body).toBe(200)

		expect(Object.keys(dataOf(body)).sort()).toEqual(
			Object.keys(acceptInvitationResultSchema.shape).sort(),
		)
		expect(dataOf(body)).toEqual({ accepted: true })
	})
})

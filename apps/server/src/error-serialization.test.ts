import { randomUUID } from "node:crypto"
import { trpcServer } from "@hono/trpc-server"
import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
import {
	createAuditController,
	createAuditControllerTransaction,
	createHostController,
	createJobQueue,
	createSshKeyController,
	type HostControllerDeps,
	type HostRepository,
	type SendJob,
	type SshKeyRepository,
	type WithSshKeyTransaction,
	type WithTransaction,
} from "@open-mcc/core"
import { createDb, type HostRow } from "@open-mcc/db"
import { createFakeRootSession, createFakeTransport } from "@open-mcc/transport"
import { Hono } from "hono"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createAuth } from "./auth"
import type { RequestContext } from "./context"
import { memberControllerFor } from "./members"
import { appRouter } from "./routers/index"
import { createTestDestinationController } from "./test/destination-controller"
import { createTestInstanceController } from "./test/instance-controller"
import { createTestSelfHostController } from "./test/self-host-controller"
import { createTestStatusController } from "./test/status-controller"

const encodeAlgorithmBlob = (algorithm: string, extra: Buffer): Buffer => {
	const name = Buffer.from(algorithm, "ascii")
	const length = Buffer.alloc(4)
	length.writeUInt32BE(name.length, 0)
	return Buffer.concat([length, name, extra])
}

const PRESENTED_HOST_KEY = encodeAlgorithmBlob("ssh-ed25519", Buffer.from("presented-key-material"))
const PRESENTED_FINGERPRINT = fingerprintFromKey(PRESENTED_HOST_KEY)
const CLIENT_EXPECTED_FINGERPRINT = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

const notCalled = (label: string) => async () => {
	throw new Error(`${label} should not be called in this test`)
}

const hosts: HostRepository = {
	insert: vi.fn(notCalled("hosts.insert")),
	findById: vi.fn(async () => undefined),
	list: vi.fn(async () => []),
	update: vi.fn(async () => undefined),
	delete: vi.fn(async () => false),
	recordProvisioningProgress: vi.fn(async () => undefined),
	recordProvisioningFailure: vi.fn(async () => undefined),
	lockHost: vi.fn(async () => undefined),
	claimForProvisioning: vi.fn(async () => undefined),
	finalizeProvisioning: vi.fn(async () => undefined),
	beginTeardown: vi.fn(async () => true),
	recordTeardownFailure: vi.fn(async () => undefined),
	deleteAfterTeardown: vi.fn(async () => true),
	instanceCount: vi.fn(async () => 0),
	listPollableAcrossOrganizations: vi.fn(async () => []),
	recordSeen: vi.fn(async () => undefined),
	updateHostKeyTrust: vi.fn(async () => undefined),
}

const sshKeys: SshKeyRepository = {
	insert: vi.fn(notCalled("sshKeys.insert")),
	findById: vi.fn(async () => undefined),
	list: vi.fn(async () => []),
	delete: vi.fn(async () => false),
}

const withTransaction: WithTransaction = (fn) =>
	fn({
		hosts,
		audit: { record: vi.fn(notCalled("audit.record")) },
		jobs: { enqueue: vi.fn(notCalled("jobs.enqueue")) },
	})

const probeHostKeyMock = vi.fn(async (): Promise<Buffer> => PRESENTED_HOST_KEY)

const hostControllerDeps: HostControllerDeps = {
	hosts,
	sshKeys: { findById: vi.fn(async () => undefined) },
	secrets: { activeKeyId: "k1", seal: vi.fn(), open: vi.fn() },
	probeHostKey: probeHostKeyMock,
	probeSshHandshake: async () => ({ kind: "key", key: Buffer.alloc(0) }),
	createTransport: () => createFakeTransport(),
	createRootSession: () => createFakeRootSession(),
	evictHost: () => undefined,
	now: () => new Date(),
	withTransaction,
}

const withSshKeyTransaction: WithSshKeyTransaction = (fn) =>
	fn({ sshKeys, audit: { record: vi.fn(notCalled("audit.record")) } })

const hostController = createHostController(hostControllerDeps)
const sshKeyController = createSshKeyController({
	sshKeys,
	secrets: hostControllerDeps.secrets,
	generateKeyPair: vi.fn((_name: string) => {
		throw new Error("generateKeyPair should not be called in this test")
	}),
	withTransaction: withSshKeyTransaction,
})
const db = createDb(process.env.TEST_DATABASE_URL ?? "")
const auth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000")

const organizationId = randomUUID()
const userId = randomUUID()
const memberId = randomUUID()

await db
	.insertInto("organization")
	.values({ id: organizationId, name: "errors", slug: `errors-${organizationId.slice(0, 8)}` })
	.execute()
await db
	.insertInto("user")
	.values({ id: userId, name: "actor", email: `${userId}@example.com` })
	.execute()
await db.insertInto("member").values({ id: memberId, organizationId, userId }).execute()

const queue = { answer: async (): Promise<string | null> => "job" }

const sendJob: SendJob = async () => await queue.answer()

const ctx: RequestContext = {
	actor: {
		organizationId,
		memberId,
		actorLabel: "actor@example.com",
		role: "owner",
	},
	auth,
	signupAuth: auth,
	singleSignOn: null,
	databaseUrl: process.env.TEST_DATABASE_URL ?? "",
	headers: new Headers(),
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
	destinationController: createTestDestinationController(db, hostControllerDeps.secrets, sendJob),
	memberController: memberControllerFor(db, auth, () => undefined),
	sshKeyController,
	selfHostController: createTestSelfHostController(db, hostController.enroll),
	updateStates: {
		find: async () => undefined,
		recordCheck: async () => undefined,
	},
	auditController: createAuditController({
		withTransaction: createAuditControllerTransaction(db),
	}),
	db,
}

const app = new Hono()
app.use(
	"/trpc/*",
	trpcServer({
		router: appRouter,
		createContext: () => ctx,
	}),
)

afterAll(async () => {
	vi.restoreAllMocks()
	await db.deleteFrom("organization").where("id", "=", organizationId).execute()
	await db.deleteFrom("user").where("id", "=", userId).execute()
	await db.destroy()
})

const enrollBody = (expectedFingerprint: string = CLIENT_EXPECTED_FINGERPRINT): string =>
	JSON.stringify({
		name: "vps-1",
		hostname: "host.example.internal",
		port: 22,
		username: "root",
		sshKeyId: "key-1",
		expectedFingerprint,
	})

const postEnroll = (body: string) =>
	app.request("/trpc/host.enroll", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	})

const postDestination = (url: string) =>
	app.request("/trpc/notification.create", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "On-call webhook",
			destination: { kind: "webhook", config: { url } },
			subscribedTo: ["host.unreachable"],
		}),
	})

describe("HTTP error serialization of a fingerprint mismatch", () => {
	it("returns a client error without echoing the presented or expected fingerprint", async () => {
		const res = await postEnroll(enrollBody())
		const body = await res.text()

		expect(res.status).toBe(400)
		expect(body).not.toContain(PRESENTED_FINGERPRINT)
		expect(body).not.toContain(CLIENT_EXPECTED_FINGERPRINT)
		expect(body).not.toContain("SHA256:")
		expect(body.toLowerCase()).not.toContain("stack")
	})
})

describe("HTTP error serialization regression coverage", () => {
	it("names a host it could not reach during enrolment as unreachable, without its address", async () => {
		probeHostKeyMock.mockRejectedValueOnce(
			new Error("Timed out reading host key from 203.0.113.9:2222"),
		)

		const res = await postEnroll(enrollBody())
		const body = await res.text()

		expect(res.status).toBe(400)
		expect(body).toContain("HOST_UNREACHABLE")
		expect(body).not.toContain("203.0.113.9")
		expect(body).not.toContain("2222")
	})

	it("gives a generic message for a thrown non-Error value", async () => {
		vi.mocked(hosts.insert).mockRejectedValueOnce({ reason: "unexpected shape", code: "WEIRD" })

		const res = await postEnroll(enrollBody(PRESENTED_FINGERPRINT))
		const body = await res.text()

		expect(res.status).toBe(500)
		expect(body).toContain("Internal server error")
		expect(body).not.toContain("unexpected shape")
		expect(body).not.toContain("WEIRD")
		expect(body.toLowerCase()).not.toContain("stack")
	})

	it("rejects a Zod input validation failure with a 400 and no stack, without genericizing the message", async () => {
		const res = await postEnroll(enrollBody("not-a-fingerprint"))
		const body = await res.text()

		expect(res.status).toBe(400)
		expect(body).toContain("OpenSSH SHA256 fingerprint")
		expect(body.toLowerCase()).not.toContain("stack")
	})

	it("never leaks a fake secret carried on an unexpected exception message", async () => {
		const fakeSecret = "sealbox-private-key-DO-NOT-LEAK-9f8e7d6c"
		vi.mocked(hosts.insert).mockRejectedValueOnce(new Error(`insert failed: key=${fakeSecret}`))

		const res = await postEnroll(enrollBody(PRESENTED_FINGERPRINT))
		const body = await res.text()

		expect(res.status).toBe(500)
		expect(body).toContain("Internal server error")
		expect(body).not.toContain(fakeSecret)
		expect(body.toLowerCase()).not.toContain("stack")
	})
})

const errorBody = z.object({
	error: z.object({
		message: z.string(),
		data: z.object({ httpStatus: z.number() }),
	}),
})

const readError = async (res: Response) => {
	const raw = await res.text()
	return { raw, body: errorBody.parse(JSON.parse(raw)) }
}

describe("what a rejected input tells the dashboard", () => {
	it("sends the contract's own sentence rather than the list of issues behind it", async () => {
		const { raw, body } = await readError(await postEnroll(enrollBody("not-a-fingerprint")))

		expect(body.error.data.httpStatus).toBe(400)
		expect(body.error.message).toBe("Expected an OpenSSH SHA256 fingerprint")
		expect(raw).not.toContain("invalid_string")
		expect(raw).not.toContain('"validation"')
		expect(raw).not.toMatch(/"path":\s*\[/)
	})

	it("★ tells an operator their address is not a web address, not to check what they entered", async () => {
		const { body } = await readError(await postDestination("hooks.example.com/alerts"))

		expect(body.error.data.httpStatus).toBe(400)
		expect(body.error.message).toBe(
			"That does not look like a web address. Check it and try again.",
		)
	})

	it("sends no field names, which nothing on the dashboard reads", async () => {
		const { raw } = await readError(await postEnroll(enrollBody("not-a-fingerprint")))

		expect(raw).not.toContain('"fields"')
		expect(raw).not.toContain("expectedFingerprint")
	})

	it("puts plain words in place of a message the schema library wrote", async () => {
		const input = { ...JSON.parse(enrollBody()), name: "", port: "twenty-two" }
		const { raw, body } = await readError(await postEnroll(JSON.stringify(input)))

		expect(body.error.data.httpStatus).toBe(400)
		expect(body.error.message).toBe("Check what you entered and try again.")
		expect(raw).not.toContain("String must contain")
		expect(raw).not.toContain("Expected number")
	})

	it("sends nothing of an issue list raised inside the server, which is a fault and not the input", async () => {
		const inner = z.object({ secretColumn: z.string() }).safeParse({ secretColumn: 7 })
		vi.mocked(hosts.insert).mockRejectedValueOnce(inner.error)

		const res = await postEnroll(enrollBody(PRESENTED_FINGERPRINT))
		const raw = await res.text()

		expect(res.status).toBe(500)
		expect(raw).toContain("Internal server error")
		expect(raw).not.toContain("secretColumn")
		expect(raw).not.toContain("invalid_type")
	})
})

const NOT_QUEUED = {
	status: 409,
	errorCode: "ALERT_NOT_QUEUED",
	message: "This manager could not accept this alert, so nothing was sent",
}

const wireErrorSchema = z.object({
	error: z.object({
		message: z.string(),
		data: z.object({ errorCode: z.string().optional() }),
	}),
})

const answerOf = async (res: Response) => {
	const text = await res.text()
	expect(text).not.toMatch(/Internal server error|pg-boss|Queue |notification\.deliver/)
	const { error } = wireErrorSchema.parse(JSON.parse(text))
	return { status: res.status, errorCode: error.data.errorCode, message: error.message }
}

const seedDestination = async (): Promise<string> => {
	const id = randomUUID()
	await db
		.insertInto("notificationDestination")
		.values({
			id,
			organizationId,
			name: `on-call-${id.slice(0, 8)}`,
			kind: "webhook",
			displayTarget: "https://hooks.example.invalid",
			secretEncrypted: "sealed",
			secretKeyId: "k1",
		})
		.execute()
	return id
}

const seedFailedDelivery = async (destinationId: string): Promise<string> => {
	const notificationId = randomUUID()
	await db
		.insertInto("notification")
		.values({
			id: notificationId,
			organizationId,
			kind: "host.unreachable",
			title: "basement-box is unreachable",
			body: "The last three checks did not answer.",
			subjectType: "host",
			subjectId: randomUUID(),
			dedupeKey: `event:${notificationId}`,
		})
		.execute()
	const deliveryId = randomUUID()
	await db
		.insertInto("notificationDelivery")
		.values({
			id: deliveryId,
			organizationId,
			notificationId,
			destinationId,
			state: "failed",
			attempts: 8,
			settledAt: new Date(),
			lastError: "Server refused with 404",
		})
		.execute()
	return deliveryId
}

const deliveriesFor = async (destinationId: string) =>
	await db
		.selectFrom("notificationDelivery")
		.select(["id", "state"])
		.where("organizationId", "=", organizationId)
		.where("destinationId", "=", destinationId)
		.execute()

const auditedActions = async (subjectId: string): Promise<string[]> => {
	const rows = await db
		.selectFrom("auditEvent")
		.select("action")
		.where("organizationId", "=", organizationId)
		.where("subjectId", "=", subjectId)
		.execute()
	return rows.map((row) => row.action)
}

const post = (procedure: string, input: Record<string, string>) =>
	app.request(`/trpc/${procedure}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	})

const THROWN_WITHOUT_AN_ERROR = "a manager defect that threw something other than an error"

describe("what an operator reads when the manager could not accept an alert", () => {
	it("★ a test alert the manager never accepted says so, rather than reading as a manager fault", async () => {
		const destinationId = await seedDestination()
		queue.answer = async () => null

		const res = await post("notification.test", { destinationId })

		expect(await answerOf(res)).toEqual(NOT_QUEUED)
	})

	it("★ leaves a test alert it could not accept entirely unsent, not half sent", async () => {
		const destinationId = await seedDestination()
		queue.answer = async () => null

		await post("notification.test", { destinationId })

		expect(await deliveriesFor(destinationId)).toEqual([])
		expect(await auditedActions(destinationId)).toEqual([])
	})

	it("★ leaves an alert it could not accept again under the same id, still failed and unaudited", async () => {
		const destinationId = await seedDestination()
		const deliveryId = await seedFailedDelivery(destinationId)
		queue.answer = async () => null

		const res = await post("notification.retry", { deliveryId })

		expect(await answerOf(res)).toEqual(NOT_QUEUED)
		expect(await deliveriesFor(destinationId)).toEqual([{ id: deliveryId, state: "failed" }])
		expect(await auditedActions(deliveryId)).toEqual([])
	})

	it("★ says the same when the manager has nowhere to put the work at all", async () => {
		const destinationId = await seedDestination()
		queue.answer = async () => {
			throw new Error("Queue notification.deliver.http does not exist")
		}

		const res = await post("notification.test", { destinationId })

		expect(await answerOf(res)).toEqual(NOT_QUEUED)
	})

	it("★ still records a test alert the manager could accept, so the refusal is not blanket", async () => {
		const destinationId = await seedDestination()
		queue.answer = async () => "job"

		const res = await post("notification.test", { destinationId })

		expect(res.status).toBe(200)
		expect(await deliveriesFor(destinationId)).toEqual([
			{ id: expect.any(String), state: "queued" },
		])
		expect(await auditedActions(destinationId)).toEqual(["notification.destination.test"])
	})

	it("★ leaves a defect raised while queueing a server fault, never the operator's to act on", async () => {
		const destinationId = await seedDestination()
		queue.answer = async () => {
			throw new TypeError("payload.forEach is not a function")
		}

		const res = await post("notification.test", { destinationId })
		const text = await res.text()

		expect(res.status).toBe(500)
		expect(text).toContain("Internal server error")
		expect(text).not.toContain(NOT_QUEUED.errorCode)
		expect(text).not.toContain(NOT_QUEUED.message)
		expect(text).not.toContain("forEach")
	})

	it("★ leaves a queue that threw something other than an error a server fault as well", async () => {
		const destinationId = await seedDestination()
		queue.answer = () => Promise.reject(THROWN_WITHOUT_AN_ERROR)

		const res = await post("notification.test", { destinationId })
		const text = await res.text()

		expect(res.status).toBe(500)
		expect(text).toContain("Internal server error")
		expect(text).not.toContain(NOT_QUEUED.errorCode)
		expect(text).not.toContain(NOT_QUEUED.message)
		expect(text).not.toContain(THROWN_WITHOUT_AN_ERROR)
	})
})

const REMOVAL_NOT_STARTED = {
	status: 409,
	errorCode: "HOST_REMOVAL_NOT_STARTED",
	message: "This manager could not start removing this host, so nothing on it was changed",
}

const REMOVABLE_HOST: HostRow = {
	id: "host-teardown-1",
	organizationId,
	name: "vps-teardown",
	hostname: "10.0.0.7",
	port: 22,
	username: "mcc",
	networkStack: null,
	architecture: null,
	osId: "debian",
	osName: "Debian GNU/Linux 12 (bookworm)",
	failedUnits: null,
	teardownError: null,
	teardownRequestedAt: null,
	sshKeyId: "key-1",
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: PRESENTED_FINGERPRINT,
	hostKeyTrustedBy: memberId,
	hostKeyTrustedByLabel: "actor@example.com",
	hostKeyTrustedAt: new Date(),
	status: "ready",
	provisioningAttemptId: null,
	provisioningClaimedAt: null,
	provisioningStep: null,
	provisioningStepIndex: null,
	provisioningStepTotal: null,
	provisioningError: null,
	osRelease: "systemd 252",
	cpuCount: null,
	memoryMb: null,
	lastSeenAt: null,
	createdAt: new Date(),
}

const teardownQueue = { answer: async (): Promise<string | null> => "job" }

const teardownAudited: string[] = []

const teardownHosts: HostRepository = {
	...hosts,
	findById: vi.fn(async () => REMOVABLE_HOST),
	lockHost: vi.fn(async () => undefined),
	instanceCount: vi.fn(async () => 0),
	beginTeardown: vi.fn(async () => true),
}

const teardownController = createHostController({
	...hostControllerDeps,
	hosts: teardownHosts,
	withTransaction: (fn) =>
		fn({
			hosts: teardownHosts,
			audit: {
				record: async (scope, entry) => {
					teardownAudited.push(entry.action)
					return {
						id: `audit-${teardownAudited.length}`,
						organizationId: scope.organizationId,
						actorId: entry.actorId,
						actorLabel: entry.actorLabel,
						action: entry.action,
						subjectType: entry.subjectType,
						subjectId: entry.subjectId,
						detail: entry.detail,
						createdAt: new Date(),
					}
				},
			},
			jobs: createJobQueue(async () => await teardownQueue.answer(), db),
		}),
})

const teardownApp = new Hono()
teardownApp.use(
	"/trpc/*",
	trpcServer({
		router: appRouter,
		createContext: () => ({ ...ctx, hostController: teardownController }),
	}),
)

const postRemove = () =>
	teardownApp.request("/trpc/host.remove", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ hostId: REMOVABLE_HOST.id }),
	})

describe("what an operator reads when the manager could not start removing a host", () => {
	beforeEach(() => {
		teardownAudited.length = 0
		teardownQueue.answer = async () => "job"
	})

	it("★ a removal the queue silently refused says so, rather than reading as a manager fault", async () => {
		teardownQueue.answer = async () => null

		const res = await postRemove()

		expect(await answerOf(res)).toEqual(REMOVAL_NOT_STARTED)
		expect(teardownAudited).toEqual([])
	})

	it("★ says the same when the manager has nowhere to put the teardown at all", async () => {
		teardownQueue.answer = async () => {
			throw new Error("Queue host.teardown does not exist")
		}

		const res = await postRemove()

		expect(await answerOf(res)).toEqual(REMOVAL_NOT_STARTED)
		expect(teardownAudited).toEqual([])
	})

	it("★ still requests a teardown the manager could queue, so the refusal is not blanket", async () => {
		const res = await postRemove()

		expect(res.status).toBe(200)
		expect(teardownAudited).toEqual(["host.teardown.requested"])
	})

	it("★ leaves a defect raised while queueing a teardown a server fault, never the operator's to act on", async () => {
		teardownQueue.answer = async () => {
			throw new TypeError("payload.forEach is not a function")
		}

		const res = await postRemove()
		const text = await res.text()

		expect(res.status).toBe(500)
		expect(text).toContain("Internal server error")
		expect(text).not.toContain(REMOVAL_NOT_STARTED.errorCode)
		expect(text).not.toContain(REMOVAL_NOT_STARTED.message)
		expect(text).not.toContain("forEach")
		expect(teardownAudited).toEqual([])
	})

	it("★ leaves a teardown queue that threw something other than an error a server fault as well", async () => {
		teardownQueue.answer = () => Promise.reject(THROWN_WITHOUT_AN_ERROR)

		const res = await postRemove()
		const text = await res.text()

		expect(res.status).toBe(500)
		expect(text).toContain("Internal server error")
		expect(text).not.toContain(REMOVAL_NOT_STARTED.errorCode)
		expect(text).not.toContain(REMOVAL_NOT_STARTED.message)
		expect(text).not.toContain(THROWN_WITHOUT_AN_ERROR)
		expect(teardownAudited).toEqual([])
	})
})

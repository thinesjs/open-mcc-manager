import { trpcServer } from "@hono/trpc-server"
import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
import {
	createHostController,
	createSshKeyController,
	type HostControllerDeps,
	type HostRepository,
	type SshKeyRepository,
	type WithSshKeyTransaction,
	type WithTransaction,
} from "@open-mcc/core"
import { createDb } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { Hono } from "hono"
import { afterAll, describe, expect, it, vi } from "vitest"
import { createAuth } from "./auth"
import type { RequestContext } from "./context"
import { appRouter } from "./routers/index"
import { createTestInstanceController } from "./test/instance-controller"

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
	fn({ hosts, audit: { record: vi.fn(notCalled("audit.record")) } })

const probeHostKeyMock = vi.fn(async (): Promise<Buffer> => PRESENTED_HOST_KEY)

const hostControllerDeps: HostControllerDeps = {
	hosts,
	sshKeys: { findById: vi.fn(async () => undefined) },
	secrets: { activeKeyId: "k1", seal: vi.fn(), open: vi.fn() },
	probeHostKey: probeHostKeyMock,
	createTransport: () => createFakeTransport(),
	instanceIdsOnHost: vi.fn(async () => []),
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

const ctx: RequestContext = {
	actor: {
		organizationId: "org-1",
		memberId: "mem-1",
		actorLabel: "actor@example.com",
		role: "owner",
	},
	auth,
	signupAuth: auth,
	headers: new Headers(),
	hostController,
	instanceController: await createTestInstanceController(db),
	sshKeyController,
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
	it("gives a generic message for a thrown non-Error value", async () => {
		probeHostKeyMock.mockRejectedValueOnce({ reason: "unexpected shape", code: "WEIRD" })

		const res = await postEnroll(enrollBody())
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
		probeHostKeyMock.mockRejectedValueOnce(new Error(`connection failed: key=${fakeSecret}`))

		const res = await postEnroll(enrollBody())
		const body = await res.text()

		expect(res.status).toBe(500)
		expect(body).toContain("Internal server error")
		expect(body).not.toContain(fakeSecret)
		expect(body.toLowerCase()).not.toContain("stack")
	})
})

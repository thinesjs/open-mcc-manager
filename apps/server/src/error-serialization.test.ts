import { trpcServer } from "@hono/trpc-server"
import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
import {
	createHostController,
	type HostControllerDeps,
	type HostRepository,
	type SshKeyRepository,
	type WithTransaction,
} from "@open-mcc/core"
import { createDb } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { Hono } from "hono"
import { afterAll, describe, expect, it, vi } from "vitest"
import type { RequestContext } from "./context"
import { appRouter } from "./routers/index"

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
	lockHost: vi.fn(async () => undefined),
	claimForProvisioning: vi.fn(async () => undefined),
	finalizeProvisioning: vi.fn(async () => undefined),
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

const hostControllerDeps: HostControllerDeps = {
	hosts,
	sshKeys: { findById: vi.fn(async () => undefined) },
	secrets: { activeKeyId: "k1", seal: vi.fn(), open: vi.fn() },
	probeHostKey: vi.fn(async () => PRESENTED_HOST_KEY),
	createTransport: () => createFakeTransport(),
	instancesRoot: "/srv/open-mcc",
	withTransaction,
}

const hostController = createHostController(hostControllerDeps)
const db = createDb(process.env.TEST_DATABASE_URL ?? "")

const ctx: RequestContext = {
	actor: {
		organizationId: "org-1",
		memberId: "mem-1",
		actorLabel: "actor@example.com",
		role: "owner",
	},
	hostController,
	sshKeys,
	secrets: hostControllerDeps.secrets,
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

describe("HTTP error serialization of a fingerprint mismatch", () => {
	it("returns a client error without echoing the presented or expected fingerprint", async () => {
		const res = await app.request("/trpc/host.enroll", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "vps-1",
				hostname: "host.example.internal",
				port: 22,
				username: "root",
				sshKeyId: "key-1",
				expectedFingerprint: CLIENT_EXPECTED_FINGERPRINT,
			}),
		})

		const body = await res.text()

		expect(res.status).toBe(400)
		expect(body).not.toContain(PRESENTED_FINGERPRINT)
		expect(body).not.toContain(CLIENT_EXPECTED_FINGERPRINT)
		expect(body).not.toContain("SHA256:")
		expect(body.toLowerCase()).not.toContain("stack")
	})
})

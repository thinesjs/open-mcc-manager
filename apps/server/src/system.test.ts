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
	type ProcessIdentityRepository,
} from "@open-mcc/core"
import { createDb, type ProcessIdentityRow } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { Hono } from "hono"
import { afterAll, describe, expect, it } from "vitest"
import { createAuth } from "./auth"
import type { RequestContext } from "./context"
import { memberControllerFor } from "./members"
import { appRouter } from "./routers/index"
import { createTestDestinationController } from "./test/destination-controller"
import { createTestInstanceController } from "./test/instance-controller"
import { createTestSelfHostController } from "./test/self-host-controller"
import { createTestStatusController } from "./test/status-controller"

const db = createDb(process.env.TEST_DATABASE_URL ?? "")
const auth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000")
const secrets = await createSecretStore(await generateKeyPair("k1"))
const sshKeys = createSshKeyRepository(db)

const hostController = createHostController({
	hosts: createHostRepository(db),
	sshKeys,
	secrets,
	probeHostKey: async () => {
		throw new Error("no host is probed in this test")
	},
	createTransport: () => createFakeTransport(),
	evictHost: () => undefined,
	instanceIdsOnHost: async () => [],
	now: () => new Date(),
	withTransaction: createHostControllerTransaction(db, async () => null),
})

const RELEASE_BUILD = { version: "1.4.0", commit: "abc123def456" }

const workerRow = (patch: Partial<ProcessIdentityRow> = {}): ProcessIdentityRow => ({
	role: "worker",
	version: "1.4.0",
	commit: "abc123def456",
	schemaVersion: "test",
	startedAt: new Date("2026-09-06T11:00:00.000Z"),
	seenAt: new Date("2026-09-06T12:00:00.000Z"),
	...patch,
})

const processIdentitiesReporting = (
	row: ProcessIdentityRow | undefined,
): ProcessIdentityRepository => ({
	announce: async () => undefined,
	heartbeat: async () => undefined,
	find: async () => row,
})

const base: RequestContext = {
	actor: {
		organizationId: "org-1",
		memberId: "mem-1",
		actorLabel: "viewer@example.com",
		role: "viewer",
	},
	auth,
	signupAuth: auth,
	headers: new Headers(),
	hostController,
	processIdentities: processIdentitiesReporting(undefined),
	build: RELEASE_BUILD,
	schemaVersion: "test",
	instanceController: await createTestInstanceController(db),
	statusController: createTestStatusController(db),
	sshKeyController: createSshKeyController({
		sshKeys,
		secrets,
		generateKeyPair: generateSshKeyPair,
		withTransaction: createSshKeyControllerTransaction(db),
	}),
	selfHostController: createTestSelfHostController(db, hostController.enroll),
	destinationController: createTestDestinationController(db, secrets),
	memberController: memberControllerFor(db, auth, () => undefined),
	updateStates: { find: async () => undefined, recordCheck: async () => undefined },
	db,
}

const ask = async (patch: Partial<RequestContext>) => {
	const app = new Hono()
	app.use(
		"/trpc/*",
		trpcServer({ router: appRouter, createContext: () => ({ ...base, ...patch }) }),
	)
	const response = await app.request("/trpc/system.status")
	return { status: response.status, body: JSON.parse(await response.text()) }
}

afterAll(async () => {
	await db.destroy()
})

describe("when the worker last reported in", () => {
	it("sends the ISO string a JSON response carries, not a Date object", async () => {
		const { status, body } = await ask({
			processIdentities: processIdentitiesReporting(workerRow()),
		})

		expect(status).toBe(200)
		expect(body.result.data.worker.seenAt).toBe("2026-09-06T12:00:00.000Z")
	})

	it("reports no worker as null rather than nothing", async () => {
		const { status, body } = await ask({ processIdentities: processIdentitiesReporting(undefined) })

		expect(status).toBe(200)
		expect(body.result.data.worker).toBeNull()
		expect(body.result.data.condition).toBe("worker-missing")
	})
})

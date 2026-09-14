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
	type UpdateStateRepository,
} from "@open-mcc/core"
import { createDb, type UpdateStateRow } from "@open-mcc/db"
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
	instanceIdsOnHost: async () => [],
	now: () => new Date(),
	withTransaction: createHostControllerTransaction(db, async () => null),
})

const RELEASE_BUILD = { version: "1.4.0", commit: "abc123def456" }

const recorded = (patch: Partial<UpdateStateRow> = {}): UpdateStateRow => ({
	id: "singleton",
	sourceOwner: "thinesjs",
	sourceRepo: "open-mcc-manager",
	checkedAt: new Date("2026-09-13T12:41:00Z"),
	checkOutcome: "ok",
	rateLimitedUntil: null,
	latestVersion: "1.5.0",
	latestNotes: "## Fixes",
	notesTruncated: false,
	...patch,
})

const holding = (row: UpdateStateRow | undefined): UpdateStateRepository => ({
	find: async () => row,
	recordCheck: async () => {
		throw new Error("a page load must never record a check")
	},
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
	processIdentities: {
		announce: async () => undefined,
		heartbeat: async () => undefined,
		find: async () => undefined,
	},
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
	updateStates: holding(undefined),
	db,
}

const ask = async (patch: Partial<RequestContext>, procedure: string) => {
	const app = new Hono()
	app.use(
		"/trpc/*",
		trpcServer({ router: appRouter, createContext: () => ({ ...base, ...patch }) }),
	)
	const response = await app.request(`/trpc/system.${procedure}`)
	return { status: response.status, body: JSON.parse(await response.text()) }
}

afterAll(async () => {
	await db.destroy()
})

describe("the update state the dashboard reads", () => {
	it("tells any signed-in member, a viewer included, what the last check found", async () => {
		const { status, body } = await ask({ updateStates: holding(recorded()) }, "updateStatus")

		expect(status).toBe(200)
		expect(body.result.data).toEqual({
			kind: "checked",
			running: "1.4.0",
			latest: "1.5.0",
			available: true,
			checkedAt: "2026-09-13T12:41:00.000Z",
			outcome: "ok",
			rateLimitedUntil: null,
			source: { owner: "thinesjs", repo: "open-mcc-manager" },
		})
	})

	it("reports a development build as one", async () => {
		const { body } = await ask(
			{ build: { version: "0.0.0-dev", commit: "unknown" }, updateStates: holding(recorded()) },
			"updateStatus",
		)

		expect(body.result.data).toEqual({ kind: "development" })
	})

	it("gives the notes of an available release as blocks", async () => {
		const { body } = await ask({ updateStates: holding(recorded()) }, "releaseNotes")

		expect(body.result.data.blocks).toEqual([
			{ kind: "heading", spans: [{ kind: "text", text: "Fixes" }] },
		])
	})

	it("answers null rather than nothing when there are no notes, so the page does not read an error", async () => {
		const { status, body } = await ask({ updateStates: holding(undefined) }, "releaseNotes")

		expect(status).toBe(200)
		expect(Object.hasOwn(body.result, "data")).toBe(true)
		expect(body.result.data).toBeNull()
	})

	it("refuses a caller who is not signed in", async () => {
		for (const procedure of ["updateStatus", "releaseNotes"]) {
			const { status } = await ask({ actor: null, updateStates: holding(recorded()) }, procedure)
			expect(status, procedure).toBe(401)
		}
	})
})

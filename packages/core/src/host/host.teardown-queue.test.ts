import { sql } from "kysely"
import { PgBoss } from "pg-boss"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { SendJob } from "../job/job.queue"
import { adminFor, HOST_TEARDOWN_QUEUE, reconcileQueues } from "../job/queue-setup"
import { createSshKeyRepository } from "../ssh-key/ssh-key.repository"
import {
	seedMember,
	seedOrganization,
	teardownTestDb,
	testDb,
	trackHostId,
	trackSshKeyId,
} from "../test/db"
import {
	type ActorContext,
	createHostController,
	createHostControllerTransaction,
} from "./host.controller"
import { createHostRepository } from "./host.repository"

const url = process.env.TEST_DATABASE_URL ?? ""

const SCHEMA = "pgboss_host_teardown_test"

const jobTable = sql.table(`${SCHEMA}.job`)

const queueTable = sql.table(`${SCHEMA}.queue`)

const FINGERPRINT = "SHA256:teardown-queue-fixture"

const CACHE_WARMER = "cache-warmer"

const sendJobOn =
	(boss: PgBoss): SendJob =>
	(queue, payload, runner) =>
		boss.send(queue, payload, { db: runner })

const teardownJobsFor = async (hostId: string): Promise<{ id: string }[]> => {
	const result = await sql<{ id: string }>`
		select id from ${jobTable}
		where name = ${HOST_TEARDOWN_QUEUE} and data->>'hostId' = ${hostId}
	`.execute(testDb())
	return [...result.rows]
}

const teardownAuditFor = async (hostId: string): Promise<{ action: string }[]> => {
	const result = await sql<{ action: string }>`
		select action from "auditEvent"
		where "subjectId" = ${hostId} and action = 'host.teardown.requested'
	`.execute(testDb())
	return [...result.rows]
}

const dropTeardownJobs = async (): Promise<void> => {
	await sql`delete from ${jobTable} where name = ${HOST_TEARDOWN_QUEUE}`.execute(testDb())
}

const restoreQueueRow = async (boss: PgBoss): Promise<void> => {
	await reconcileQueues(
		adminFor({
			createQueue: async (name, options) => await boss.createQueue(name, options),
			updateQueue: async (name, options) => await boss.updateQueue(name, options),
			getQueue: async (name) => await boss.getQueue(name),
		}),
	)
}

const warmQueueCache = async (boss: PgBoss): Promise<void> => {
	await boss.send(HOST_TEARDOWN_QUEUE, { hostId: CACHE_WARMER })
	await sql`
		delete from ${jobTable}
		where name = ${HOST_TEARDOWN_QUEUE} and data->>'hostId' = ${CACHE_WARMER}
	`.execute(testDb())
}

const forgetQueueRow = async (): Promise<void> => {
	await sql`delete from ${queueTable} where name = ${HOST_TEARDOWN_QUEUE}`.execute(testDb())
}

const seedReadyHost = async (slugPrefix: string) => {
	const organizationId = await seedOrganization(slugPrefix)
	const memberId = await seedMember(organizationId)
	const db = testDb()
	const hosts = createHostRepository(db)
	const sshKeys = createSshKeyRepository(db)
	const key = await sshKeys.insert(
		{ organizationId },
		{
			name: `${slugPrefix}-key`,
			publicKey: "ssh-ed25519 AAAA...",
			privateKeyEncrypted: "sealed",
			privateKeyKeyId: "k1",
		},
	)
	trackSshKeyId(key.id)
	const created = await hosts.insert(
		{ organizationId },
		{
			name: `${slugPrefix}-host`,
			hostname: "10.0.0.94",
			port: 22,
			username: "mcc",
			osRelease: "systemd 252",
			osId: "debian",
			osName: "Debian GNU/Linux 12 (bookworm)",
			failedUnits: null,
			teardownError: null,
			teardownRequestedAt: null,
			sshKeyId: key.id,
			hostKeyAlgorithm: "ssh-ed25519",
			hostKeyFingerprint: FINGERPRINT,
			hostKeyTrustedBy: memberId,
			hostKeyTrustedByLabel: "actor@example.com",
			hostKeyTrustedAt: new Date(),
			status: "ready",
		},
	)
	trackHostId(created.id)
	return { organizationId, memberId, db, hosts, sshKeys, hostId: created.id }
}

type Seeded = Awaited<ReturnType<typeof seedReadyHost>>

const controllerOver = (seeded: Seeded, sendJob: SendJob, evicted: string[]) =>
	createHostController({
		hosts: seeded.hosts,
		sshKeys: seeded.sshKeys,
		secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
		probeHostKey: vi.fn(),
		probeSshHandshake: vi.fn(),
		createTransport: vi.fn(() => {
			throw new Error("removing a host opened an SSH transport")
		}),
		createRootSession: vi.fn(() => {
			throw new Error("removing a host opened a root SSH session")
		}),
		evictHost: (_organizationId, hostId) => {
			evicted.push(hostId)
		},
		now: () => new Date(),
		withTransaction: createHostControllerTransaction(seeded.db, sendJob),
	})

const actorFor = (organizationId: string, memberId: string): ActorContext => ({
	organizationId,
	memberId,
	actorLabel: "actor@example.com",
	role: "owner",
})

const untouched = async (seeded: Seeded): Promise<void> => {
	const host = await seeded.hosts.findById({ organizationId: seeded.organizationId }, seeded.hostId)
	expect(host?.status).toBe("ready")
	expect(host?.teardownRequestedAt).toBeNull()
	expect(await teardownJobsFor(seeded.hostId)).toEqual([])
	expect(await teardownAuditFor(seeded.hostId)).toEqual([])
}

let boss: PgBoss

beforeEach(async () => {
	if (boss === undefined) {
		boss = new PgBoss({ connectionString: url, schema: SCHEMA })
		await boss.start()
	}
	await dropTeardownJobs()
	await restoreQueueRow(boss)
}, 60_000)

afterAll(async () => {
	await dropTeardownJobs()
	await restoreQueueRow(boss)
	await boss.stop({ graceful: false })
	await teardownTestDb()
})

describe("host removal against the real teardown queue (real Postgres, real pg-boss)", () => {
	it("★ leaves a host whose teardown the queue silently refused exactly as the operator found it", async () => {
		const seeded = await seedReadyHost("org-teardown-silent")
		const evicted: string[] = []
		const controller = controllerOver(seeded, sendJobOn(boss), evicted)

		await warmQueueCache(boss)
		await forgetQueueRow()

		const settled = await Promise.allSettled([
			controller.remove(actorFor(seeded.organizationId, seeded.memberId), seeded.hostId),
		])

		await untouched(seeded)
		expect(evicted).toEqual([])
		expect(settled[0]?.status).toBe("rejected")
	}, 60_000)

	it("★ leaves a host whose teardown the queue refused out loud exactly as the operator found it", async () => {
		const seeded = await seedReadyHost("org-teardown-loud")
		const evicted: string[] = []
		const controller = controllerOver(seeded, sendJobOn(boss), evicted)

		await forgetQueueRow()

		const settled = await Promise.allSettled([
			controller.remove(actorFor(seeded.organizationId, seeded.memberId), seeded.hostId),
		])

		await untouched(seeded)
		expect(evicted).toEqual([])
		expect(settled[0]?.status).toBe("rejected")
	}, 60_000)

	it("★ marks a host removing only alongside the teardown job that will carry it out", async () => {
		const seeded = await seedReadyHost("org-teardown-queued")
		const evicted: string[] = []
		const controller = controllerOver(seeded, sendJobOn(boss), evicted)

		await expect(
			controller.remove(actorFor(seeded.organizationId, seeded.memberId), seeded.hostId),
		).resolves.toBe(true)

		const host = await seeded.hosts.findById(
			{ organizationId: seeded.organizationId },
			seeded.hostId,
		)
		expect(host?.status).toBe("removing")
		expect(host?.teardownRequestedAt).not.toBeNull()

		const queued = await teardownJobsFor(seeded.hostId)
		expect(queued).toHaveLength(1)
		expect(await teardownAuditFor(seeded.hostId)).toHaveLength(1)
		expect(evicted).toEqual([seeded.hostId])
	}, 60_000)
})

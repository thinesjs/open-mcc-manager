import { sql } from "kysely"
import { nanoid } from "nanoid"
import { PgBoss } from "pg-boss"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import type { SendJob } from "../job/job.queue"
import {
	adminFor,
	NOTIFICATION_DEADLETTER_QUEUE,
	NOTIFICATION_HTTP_QUEUE,
	reconcileQueues,
} from "../job/queue-setup"
import { seedOrganization, teardownTestDb, testDb } from "../test/db"
import { createDeliveryHandler, createDeliveryTransaction } from "./delivery.job"
import { PUBLIC_ONLY } from "./egress"
import { createNotificationRepository } from "./notification.repository"
import type { DeliveryOutcome } from "./outcome"

const url = process.env.TEST_DATABASE_URL ?? ""

let boss: PgBoss

const SCHEMA = "pgboss_delivery_job_test"

const jobTable = sql.table(`${SCHEMA}.job`)

const queueTable = sql.table(`${SCHEMA}.queue`)

const CACHE_WARMER = "cache-warmer"

const SETTLED_AT = new Date("2026-09-07T12:00:00Z")

const RETRYABLE: DeliveryOutcome = {
	kind: "retryable",
	statusCode: 503,
	reason: "Server answered 503",
	retryAfterSeconds: 45,
}

const TERMINAL: DeliveryOutcome = {
	kind: "terminal",
	statusCode: 404,
	reason: "Server refused with 404",
	stopSending: false,
}

type QueueAnswer = { queue: string; jobId: string | null } | { queue: string; refused: string }

const recordingSendJob = (answers: QueueAnswer[]): SendJob => {
	const send: SendJob = async (queue, payload, runner, options) => {
		try {
			const jobId = await boss.send(queue, payload, {
				db: runner,
				...(options === undefined ? {} : { startAfter: options.startAfterSeconds }),
			})
			answers.push({ queue, jobId })
			return jobId
		} catch (error) {
			answers.push({ queue, refused: error instanceof Error ? error.message : String(error) })
			throw error
		}
	}
	return send
}

const restoreQueueRows = async (): Promise<void> => {
	await reconcileQueues(
		adminFor({
			createQueue: async (name, options) => await boss.createQueue(name, options),
			updateQueue: async (name, options) => await boss.updateQueue(name, options),
			getQueue: async (name) => await boss.getQueue(name),
		}),
	)
}

const dropAllJobs = async (): Promise<void> => {
	await sql`delete from ${jobTable}`.execute(testDb())
}

const warmQueueCache = async (queue: string): Promise<void> => {
	await boss.send(queue, { deliveryId: CACHE_WARMER })
	await sql`
		delete from ${jobTable} where name = ${queue} and data->>'deliveryId' = ${CACHE_WARMER}
	`.execute(testDb())
}

const forgetQueueRow = async (queue: string): Promise<void> => {
	await sql`update ${queueTable} set dead_letter = null where dead_letter = ${queue}`.execute(
		testDb(),
	)
	await sql`delete from ${queueTable} where name = ${queue}`.execute(testDb())
}

type Seeded = {
	organizationId: string
	destinationId: string
	deliveryId: string
}

const seedQueuedDelivery = async (slugPrefix: string): Promise<Seeded> => {
	const organizationId = await seedOrganization(slugPrefix)
	const destinationId = `dst-${nanoid()}`
	const notificationId = `ntf-${nanoid()}`
	const deliveryId = `dlv-${nanoid()}`
	const db = testDb()

	await db
		.insertInto("notificationDestination")
		.values({
			id: destinationId,
			organizationId,
			name: "My webhook",
			kind: "webhook",
			displayTarget: "https://hooks.example.com",
			secretEncrypted: "sealed",
			secretKeyId: "k1",
		})
		.execute()
	await db
		.insertInto("notification")
		.values({
			id: notificationId,
			organizationId,
			kind: "host.unreachable",
			title: "basement-box is not responding",
			body: "OpenMCC cannot reach this machine.",
			subjectType: "host",
			subjectId: "host-under-test",
			dedupeKey: `event:${notificationId}`,
			sourceStatusEventId: null,
		})
		.execute()
	await db
		.insertInto("notificationDelivery")
		.values({ id: deliveryId, organizationId, notificationId, destinationId, state: "queued" })
		.execute()

	return { organizationId, destinationId, deliveryId }
}

const handlerFor = (sendJob: SendJob, outcome: DeliveryOutcome) =>
	createDeliveryHandler({
		store: createNotificationRepository(testDb()),
		withTransaction: createDeliveryTransaction(testDb()),
		send: async () => outcome,
		sendJob,
		queue: NOTIFICATION_HTTP_QUEUE,
		policy: PUBLIC_ONLY,
		now: () => SETTLED_AT,
		retryLimit: 3,
		onError: () => undefined,
	})

type DeliveryReadout = {
	state: string
	attempts: number
	settledAt: Date | null
	lastError: string | null
}

const deliveryRow = async (seeded: Seeded): Promise<DeliveryReadout | undefined> => {
	const row = await createNotificationRepository(testDb()).findDelivery(
		{ organizationId: seeded.organizationId },
		seeded.deliveryId,
	)
	if (!row) return undefined
	return {
		state: row.state,
		attempts: row.attempts,
		settledAt: row.settledAt,
		lastError: row.lastError,
	}
}

const attemptRows = async (
	seeded: Seeded,
): Promise<
	{ attempt: number; outcome: string; statusCode: number | null; error: string | null }[]
> =>
	await testDb()
		.selectFrom("notificationAttempt")
		.select(["attempt", "outcome", "statusCode", "error"])
		.where("organizationId", "=", seeded.organizationId)
		.where("deliveryId", "=", seeded.deliveryId)
		.execute()

const jobsFor = async (
	seeded: Seeded,
): Promise<{ name: string; data: Record<string, string>; startAfter: Date }[]> => {
	const result = await sql<{ name: string; data: Record<string, string>; start_after: Date }>`
		select name, data, start_after from ${jobTable} where data->>'deliveryId' = ${seeded.deliveryId}
		order by name
	`.execute(testDb())
	return result.rows.map((row) => ({
		name: row.name,
		data: row.data,
		startAfter: row.start_after,
	}))
}

const writingTransactionsOf = async (seeded: Seeded): Promise<string[]> => {
	const written = await sql<{ txid: string }>`
		select xmin::text as txid from "notificationDelivery" where id = ${seeded.deliveryId}
		union all
		select xmin::text as txid from "notificationAttempt" where "deliveryId" = ${seeded.deliveryId}
		union all
		select xmin::text as txid from ${jobTable} where data->>'deliveryId' = ${seeded.deliveryId}
	`.execute(testDb())
	return [...new Set(written.rows.map((row) => row.txid))]
}

const destinationRow = async (seeded: Seeded) =>
	await createNotificationRepository(testDb()).findDestination(
		{ organizationId: seeded.organizationId },
		seeded.destinationId,
	)

const stillWaiting = async (seeded: Seeded): Promise<void> => {
	expect(await deliveryRow(seeded)).toEqual({
		state: "queued",
		attempts: 0,
		settledAt: null,
		lastError: null,
	})
	expect(await attemptRows(seeded)).toEqual([])
	expect(await jobsFor(seeded)).toEqual([])
	const destination = await destinationRow(seeded)
	expect(destination?.lastFailedAt).toBeNull()
	expect(destination?.lastFailureReason).toBeNull()
	expect(destination?.enabled).toBe(true)
}

beforeEach(async () => {
	if (boss === undefined) {
		boss = new PgBoss({ connectionString: url, schema: SCHEMA })
		await boss.start()
	}
	await dropAllJobs()
	await restoreQueueRows()
}, 60_000)

afterAll(async () => {
	await dropAllJobs()
	await restoreQueueRows()
	await boss.stop({ graceful: false })
	await teardownTestDb()
})

describe("a delivery settles and requeues together or not at all (real Postgres, real pg-boss)", () => {
	it("★ leaves a delivery whose next attempt the queue silently refused still waiting, not half-tried", async () => {
		const seeded = await seedQueuedDelivery("org-delivery-silent-retry")
		const answers: QueueAnswer[] = []
		const handle = handlerFor(recordingSendJob(answers), RETRYABLE)

		await warmQueueCache(NOTIFICATION_HTTP_QUEUE)
		await forgetQueueRow(NOTIFICATION_HTTP_QUEUE)

		const settled = await Promise.allSettled([
			handle({ organizationId: seeded.organizationId, deliveryId: seeded.deliveryId, attempt: 1 }),
		])

		expect(answers).toEqual([{ queue: NOTIFICATION_HTTP_QUEUE, jobId: null }])
		await stillWaiting(seeded)
		expect(settled[0]?.status).toBe("rejected")
	}, 60_000)

	it("★ leaves a delivery it could not set aside still waiting, rather than failed with nothing keeping it", async () => {
		const seeded = await seedQueuedDelivery("org-delivery-silent-dead")
		const answers: QueueAnswer[] = []
		const handle = handlerFor(recordingSendJob(answers), TERMINAL)

		await warmQueueCache(NOTIFICATION_DEADLETTER_QUEUE)
		await forgetQueueRow(NOTIFICATION_DEADLETTER_QUEUE)

		const settled = await Promise.allSettled([
			handle({ organizationId: seeded.organizationId, deliveryId: seeded.deliveryId, attempt: 1 }),
		])

		expect(answers).toEqual([{ queue: NOTIFICATION_DEADLETTER_QUEUE, jobId: null }])
		await stillWaiting(seeded)
		expect(settled[0]?.status).toBe("rejected")
	}, 60_000)

	it("★ leaves a delivery the queue refused out loud in that same waiting state", async () => {
		const seeded = await seedQueuedDelivery("org-delivery-loud-retry")
		const answers: QueueAnswer[] = []
		const handle = handlerFor(recordingSendJob(answers), RETRYABLE)

		await forgetQueueRow(NOTIFICATION_HTTP_QUEUE)

		const settled = await Promise.allSettled([
			handle({ organizationId: seeded.organizationId, deliveryId: seeded.deliveryId, attempt: 1 }),
		])

		expect(answers).toEqual([
			{
				queue: NOTIFICATION_HTTP_QUEUE,
				refused: `Queue ${NOTIFICATION_HTTP_QUEUE} does not exist`,
			},
		])
		await stillWaiting(seeded)
		expect(settled[0]?.status).toBe("rejected")
	}, 60_000)

	it("★ records an attempt only alongside the job that will carry the next one", async () => {
		const seeded = await seedQueuedDelivery("org-delivery-retry-queued")
		const answers: QueueAnswer[] = []
		const handle = handlerFor(recordingSendJob(answers), RETRYABLE)

		expect(
			await handle({
				organizationId: seeded.organizationId,
				deliveryId: seeded.deliveryId,
				attempt: 1,
			}),
		).toEqual({ settled: "retrying", afterSeconds: 45 })

		expect(await deliveryRow(seeded)).toEqual({
			state: "queued",
			attempts: 1,
			settledAt: null,
			lastError: "Server answered 503",
		})
		expect(await attemptRows(seeded)).toEqual([
			{ attempt: 1, outcome: "retryable", statusCode: 503, error: "Server answered 503" },
		])

		const queued = await jobsFor(seeded)
		expect(queued).toHaveLength(1)
		expect(queued[0]?.name).toBe(NOTIFICATION_HTTP_QUEUE)
		expect(queued[0]?.data.attempt).toBe("2")
		expect(queued[0]?.startAfter.getTime()).toBeGreaterThan(Date.now() + 30_000)

		const destination = await destinationRow(seeded)
		expect(destination?.lastFailedAt).toEqual(SETTLED_AT)
		expect(destination?.lastFailureReason).toBe("Server answered 503")

		expect(await writingTransactionsOf(seeded)).toHaveLength(1)
	}, 60_000)

	it("★ marks a delivery failed only alongside the record that sets it aside", async () => {
		const seeded = await seedQueuedDelivery("org-delivery-dead-queued")
		const answers: QueueAnswer[] = []
		const handle = handlerFor(recordingSendJob(answers), TERMINAL)

		expect(
			await handle({
				organizationId: seeded.organizationId,
				deliveryId: seeded.deliveryId,
				attempt: 1,
			}),
		).toEqual({ settled: "failed" })

		expect(await deliveryRow(seeded)).toEqual({
			state: "failed",
			attempts: 1,
			settledAt: SETTLED_AT,
			lastError: "Server refused with 404",
		})
		expect(await attemptRows(seeded)).toEqual([
			{ attempt: 1, outcome: "terminal", statusCode: 404, error: "Server refused with 404" },
		])

		const queued = await jobsFor(seeded)
		expect(queued).toHaveLength(1)
		expect(queued[0]?.name).toBe(NOTIFICATION_DEADLETTER_QUEUE)
		expect(queued[0]?.data.organizationId).toBe(seeded.organizationId)

		expect(await writingTransactionsOf(seeded)).toHaveLength(1)
	}, 60_000)
})

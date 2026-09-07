import { sql } from "kysely"
import { PgBoss } from "pg-boss"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { asSqlRunner } from "../job/executor-adapter"
import type { SendJob } from "../job/job.queue"
import { adminFor, NOTIFICATION_HTTP_QUEUE, reconcileQueues } from "../job/queue-setup"
import { seedOrganization, teardownTestDb, testDb } from "../test/db"
import { announce } from "./announce"
import { createNotificationRepository } from "./notification.repository"
import type { EventFact } from "./producer"

const url = process.env.TEST_DATABASE_URL ?? ""

let boss: PgBoss
let sendJob: SendJob
let organizationId = ""
let destinationId = ""

const run = Math.random().toString(36).slice(2, 10)

const eventIds = {
	rollback: `evt-rollback-${run}`,
	commit: `evt-commit-${run}`,
	kick: `evt-kick-${run}`,
}

const seedStatusEvent = async (id: string): Promise<string> => {
	await testDb()
		.insertInto("statusEvent")
		.values({
			id,
			organizationId,
			subjectType: "host",
			subjectId: "host-under-test",
			subjectLabel: "basement-box",
			hostId: null,
			instanceId: null,
			kind: "host.unreachable",
			occurredAt: new Date(),
			observedAt: new Date(),
			lastCorroboratedAt: new Date(),
			incidentId: null,
			primarySource: "host_probe",
			sources: ["host_probe"],
			sourceKey: null,
			detail: {},
		})
		.execute()
	return id
}

const fact = (statusEventId: string): EventFact => ({
	statusEventId,
	kind: "host.unreachable",
	subjectType: "host",
	subjectId: "host-under-test",
	subjectName: "basement-box",
})

const countJobs = async (): Promise<number> => {
	const result = await sql<{ total: string }>`
		select count(*)::text as total from pgboss.job where name = ${NOTIFICATION_HTTP_QUEUE}
	`.execute(testDb())
	return Number(result.rows[0]?.total ?? "0")
}

const countRows = async (table: "notification" | "notificationDelivery"): Promise<number> => {
	const result = await sql<{ total: string }>`
		select count(*)::text as total from ${sql.table(table)}
		where "organizationId" = ${organizationId}
	`.execute(testDb())
	return Number(result.rows[0]?.total ?? "0")
}

beforeAll(async () => {
	boss = new PgBoss(url)
	await boss.start()
	await reconcileQueues(
		adminFor({
			createQueue: async (name, options) => await boss.createQueue(name, options),
			updateQueue: async (name, options) => await boss.updateQueue(name, options),
			getQueue: async (name) => await boss.getQueue(name),
		}),
	)
	sendJob = (queue, payload, runner) => boss.send(queue, payload, { db: runner })

	organizationId = await seedOrganization("announce-tx")
	destinationId = `dest-${run}`
	await testDb()
		.insertInto("notificationDestination")
		.values({
			id: destinationId,
			organizationId,
			name: "My webhook",
			kind: "webhook",
			displayTarget: "https://hooks.example.com",
			secretEncrypted: "sealed",
			secretKeyId: "key",
		})
		.execute()
	await testDb()
		.insertInto("notificationSubscription")
		.values({
			id: `sub-${run}`,
			organizationId,
			destinationId,
			kind: "host.unreachable",
		})
		.execute()

	for (const id of [eventIds.rollback, eventIds.commit, eventIds.kick]) await seedStatusEvent(id)
}, 60_000)

afterAll(async () => {
	await sql`delete from pgboss.job where name = ${NOTIFICATION_HTTP_QUEUE}`.execute(testDb())
	await testDb().deleteFrom("statusEvent").where("organizationId", "=", organizationId).execute()
	await boss.stop({ graceful: false })
	await teardownTestDb()
})

describe("a notification and its queued job commit together or not at all", () => {
	it("leaves nothing behind when the transaction throws after the enqueue", async () => {
		const before = await countJobs()

		await expect(
			testDb()
				.transaction()
				.execute(async (tx) => {
					await announce({ organizationId }, fact(eventIds.rollback), {
						notifications: createNotificationRepository(tx),
						sendJob,
						runner: asSqlRunner(tx),
					})
					throw new Error("something later in the transaction failed")
				}),
		).rejects.toThrow("something later in the transaction failed")

		expect(await countRows("notification")).toBe(0)
		expect(await countRows("notificationDelivery")).toBe(0)
		expect(await countJobs()).toBe(before)
	})

	it("commits the notification, the delivery and the job together", async () => {
		const before = await countJobs()

		const planned = await testDb()
			.transaction()
			.execute(
				async (tx) =>
					await announce({ organizationId }, fact(eventIds.commit), {
						notifications: createNotificationRepository(tx),
						sendJob,
						runner: asSqlRunner(tx),
					}),
			)

		expect(planned?.kind).toBe("host.unreachable")
		expect(await countRows("notification")).toBe(1)
		expect(await countRows("notificationDelivery")).toBe(1)
		expect(await countJobs()).toBe(before + 1)
	})

	it("does not announce the same status event twice", async () => {
		const beforeJobs = await countJobs()

		const planned = await testDb()
			.transaction()
			.execute(
				async (tx) =>
					await announce({ organizationId }, fact(eventIds.commit), {
						notifications: createNotificationRepository(tx),
						sendJob,
						runner: asSqlRunner(tx),
					}),
			)

		expect(planned).toBeUndefined()
		expect(await countRows("notification")).toBe(1)
		expect(await countJobs()).toBe(beforeJobs)
	})

	it("stays quiet for a kick, and queues nothing", async () => {
		const beforeJobs = await countJobs()

		const planned = await testDb()
			.transaction()
			.execute(
				async (tx) =>
					await announce(
						{ organizationId },
						{ ...fact(eventIds.kick), kind: "instance.kicked" },
						{
							notifications: createNotificationRepository(tx),
							sendJob,
							runner: asSqlRunner(tx),
						},
					),
			)

		expect(planned).toBeUndefined()
		expect(await countJobs()).toBe(beforeJobs)
	})
})

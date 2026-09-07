import {
	adminFor,
	asSqlRunner,
	createAuditRepository,
	createCleanupHandler,
	createDeliveryHandler,
	createEscalationHandler,
	createHostRepository,
	createHostTeardownHandler,
	createInstanceRepository,
	createNotificationRepository,
	createOrganizationRepository,
	createProcessIdentityRepository,
	createSecretStore,
	createSshKeyRepository,
	createStatusController,
	createStatusControllerTransaction,
	deliverQueuedBatch,
	dispatchTo,
	type EgressPolicy,
	egressPolicy,
	HOST_TEARDOWN_QUEUE,
	NOTIFICATION_CLEANUP_QUEUE,
	NOTIFICATION_EMAIL_QUEUE,
	NOTIFICATION_HTTP_QUEUE,
	type NotificationEnvelope,
	type QueueName,
	readBuildInfo,
	reconcileQueues,
	type SendJob,
	STATUS_ESCALATE_QUEUE,
	startHeartbeat,
	tracedDialect,
} from "@open-mcc/core"
import {
	appliedSchemaVersion,
	createDb,
	type Db,
	type NotificationDestinationRow,
} from "@open-mcc/db"
import { createSshTransport } from "@open-mcc/transport"
import type { Job } from "pg-boss"
import { PgBoss } from "pg-boss"
import type { WorkerEnv } from "./env"

export const CONNECT_TIMEOUT_MS = 10_000

export type WorkerHandle = {
	stop: () => Promise<void>
	db: Db
	boss: PgBoss
}

export const startWorker = async (env: WorkerEnv): Promise<WorkerHandle> => {
	const db = createDb(env.DATABASE_URL, tracedDialect)
	const secrets = await createSecretStore(env.SEALBOX_KEYS)
	const sshKeys = createSshKeyRepository(db)
	const hosts = createHostRepository(db)
	const audit = createAuditRepository(db)

	const build = readBuildInfo(process.env)
	const identities = createProcessIdentityRepository(db)
	await identities.announce(
		{
			role: "worker",
			version: build.version,
			commit: build.commit,
			schemaVersion: await appliedSchemaVersion(db),
		},
		new Date(),
	)
	const heartbeat = startHeartbeat(identities, "worker")

	const boss = new PgBoss({ connectionString: env.DATABASE_URL })
	boss.on("error", (error: Error) => {
		console.error("Job queue error", error.message)
	})
	await boss.start()
	await boss.createQueue(HOST_TEARDOWN_QUEUE)
	await reconcileQueues(
		adminFor({
			createQueue: async (name, options) => await boss.createQueue(name, options),
			updateQueue: async (name, options) => await boss.updateQueue(name, options),
			getQueue: async (name) => await boss.getQueue(name),
		}),
	)

	const teardown = createHostTeardownHandler({
		openKey: async (organizationId, sshKeyId) => {
			const key = await sshKeys.findById({ organizationId }, sshKeyId)
			if (!key) return undefined
			return { privateKey: secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId) }
		},
		connect: async (options) => {
			const transport = createSshTransport()
			await transport.connect({ ...options, timeoutMs: CONNECT_TIMEOUT_MS })
			return transport
		},
		onCleaned: async (hostId, organizationId, summary) => {
			await audit
				.record(
					{ organizationId },
					{
						actorId: null,
						actorLabel: "worker",
						action: "host.teardown",
						subjectType: "host",
						subjectId: hostId,
						detail: summary,
					},
				)
				.catch(() => undefined)
			await hosts.deleteAfterTeardown(hostId, organizationId)
		},
		onFailed: async (hostId, organizationId, reason) => {
			await hosts.recordTeardownFailure(hostId, organizationId, reason).catch(() => undefined)
		},
	})

	await boss.work(HOST_TEARDOWN_QUEUE, async (jobs: Job[]) => {
		for (const job of jobs) {
			await teardown(job.data)
		}
	})

	const policy = egressPolicy({
		allowHttp: env.NOTIFICATION_ALLOW_HTTP,
		allowedHosts: env.NOTIFICATION_ALLOWED_HOSTS,
		allowedAddresses: env.NOTIFICATION_ALLOWED_ADDRESSES,
	})

	const sendJob: SendJob = (queue, payload, runner, options) =>
		boss.send(queue, payload, {
			db: runner,
			...(options === undefined ? {} : { startAfter: options.startAfterSeconds }),
		})

	const send = async (
		destination: NotificationDestinationRow,
		envelope: NotificationEnvelope,
		egress: EgressPolicy,
	) => await dispatchTo(destination, envelope, egress, secrets)

	const deliverOn = (queue: QueueName) =>
		createDeliveryHandler({
			store: createNotificationRepository(db),
			withTransaction: (fn) =>
				db
					.transaction()
					.execute((tx) =>
						fn({ notifications: createNotificationRepository(tx), runner: asSqlRunner(tx) }),
					),
			send,
			sendJob,
			queue,
			policy,
			now: () => new Date(),
		})

	const workDeliveries = (queue: QueueName) => async (jobs: Job[]) =>
		await deliverQueuedBatch(queue, jobs, deliverOn(queue))

	const instances = createInstanceRepository(db)
	const statusController = createStatusController({
		withTransaction: createStatusControllerTransaction(db),
		sendJob,
		hostNames: async (scope) =>
			(await hosts.list(scope)).map((host) => ({ id: host.id, name: host.name })),
		instanceNames: async (scope) =>
			(await instances.list(scope)).map((row) => ({ id: row.id, name: row.name })),
		retentionDays: env.STATUS_RETENTION_DAYS,
		now: () => new Date(),
	})

	const escalations = createEscalationHandler({
		escalate: async (scope, instanceId, incidentId) => {
			const instance = await instances.findById(scope, instanceId)
			if (!instance) return false
			return await statusController.escalateInstance(
				scope,
				{ id: instance.id, name: instance.name },
				incidentId,
			)
		},
	})

	await boss.work(STATUS_ESCALATE_QUEUE, async (jobs: Job[]) => {
		for (const job of jobs) await escalations(job.data)
	})

	const cleanUp = createCleanupHandler({
		organizationIds: async () => await createOrganizationRepository(db).listIds(),
		deleteSettledBefore: async (scope, boundaries) =>
			await createNotificationRepository(db).deleteSettledBefore(scope, boundaries),
		now: () => new Date(),
	})

	await boss.schedule(NOTIFICATION_CLEANUP_QUEUE, "17 3 * * *")
	await boss.work(NOTIFICATION_CLEANUP_QUEUE, async () => {
		const removed = await cleanUp()
		if (removed > 0) console.error(`Removed ${removed} notifications past retention`)
	})

	await boss.work(NOTIFICATION_HTTP_QUEUE, workDeliveries(NOTIFICATION_HTTP_QUEUE))
	await boss.work(NOTIFICATION_EMAIL_QUEUE, workDeliveries(NOTIFICATION_EMAIL_QUEUE))

	return {
		db,
		boss,
		stop: async () => {
			heartbeat.stop()
			await boss.stop()
			await db.destroy()
		},
	}
}

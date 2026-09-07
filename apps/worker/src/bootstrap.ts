import {
	adminFor,
	asSqlRunner,
	createAuditRepository,
	createDeliveryHandler,
	createHostRepository,
	createHostTeardownHandler,
	createNotificationRepository,
	createProcessIdentityRepository,
	createSecretStore,
	createSshKeyRepository,
	dispatchTo,
	type EgressPolicy,
	egressPolicy,
	HOST_TEARDOWN_QUEUE,
	NOTIFICATION_EMAIL_QUEUE,
	NOTIFICATION_HTTP_QUEUE,
	type NotificationEnvelope,
	type QueueName,
	readBuildInfo,
	readDeliveryPayload,
	reconcileQueues,
	type SendJob,
	startHeartbeat,
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
	const db = createDb(env.DATABASE_URL)
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

	const workDeliveries = (queue: QueueName) => async (jobs: Job[]) => {
		const deliver = deliverOn(queue)
		for (const job of jobs) {
			const payload = readDeliveryPayload(job.data)
			if (payload) await deliver(payload)
		}
	}

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

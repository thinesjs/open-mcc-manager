import { instanceConfigStored } from "@open-mcc/contracts"
import {
	adminFor,
	artifactCollectJob,
	artifactCollectReporter,
	asSqlRunner,
	attachQueueWarning,
	createArtifactCollector,
	createArtifactRepository,
	createAuditRepository,
	createCleanupHandler,
	createDeliveryHandler,
	createDeliveryTransaction,
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
	createUpdateCheck,
	createUpdateStateRepository,
	deliverQueuedBatch,
	dispatchTo,
	type EgressPolicy,
	egressPolicy,
	HOST_TEARDOWN_QUEUE,
	INSTANCE_ARTIFACT_QUEUE,
	type Logger,
	malformedJobReporter,
	NOTIFICATION_CLEANUP_QUEUE,
	NOTIFICATION_EMAIL_QUEUE,
	NOTIFICATION_HTTP_QUEUE,
	type NotificationEnvelope,
	type QueueName,
	readBuildInfo,
	reconcileQueues,
	renderInstanceConfig,
	requestRelease,
	retentionSweepJob,
	retentionSweepReporter,
	runtimeErrorReporter,
	type SendJob,
	STATUS_ESCALATE_QUEUE,
	SYSTEM_UPDATE_CHECK_QUEUE,
	shouldCheckAtBoot,
	startHeartbeat,
	tracedDialect,
	UPDATE_CHECK_CRON,
	updateCheckJob,
	updateCheckReporter,
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

export const startWorker = async (env: WorkerEnv, logger: Logger): Promise<WorkerHandle> => {
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
		logger.error("Job queue error", { detail: error.message })
	})
	attachQueueWarning(boss, logger)
	await boss.start()
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
		onError: runtimeErrorReporter(logger),
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
			withTransaction: createDeliveryTransaction(db),
			send,
			sendJob,
			queue,
			policy,
			now: () => new Date(),
			onError: runtimeErrorReporter(logger),
		})

	const workDeliveries = (queue: QueueName) => async (jobs: Job[]) =>
		await deliverQueuedBatch(queue, jobs, deliverOn(queue), malformedJobReporter(logger))

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
	await boss.work(
		NOTIFICATION_CLEANUP_QUEUE,
		retentionSweepJob(cleanUp, retentionSweepReporter(logger)),
	)

	const artifacts = createArtifactRepository(db)
	const collectArtifacts = createArtifactCollector({
		organizationIds: async () => await createOrganizationRepository(db).listIds(),
		hosts: async (scope) => await hosts.list(scope),
		host: async (scope, hostId) => await hosts.findById(scope, hostId),
		instancesOn: async (scope, hostId) =>
			(await instances.list(scope)).filter((row) => row.hostId === hostId),
		savedDocument: async (scope, instanceId) => {
			const saved = await instances.latestConfig(scope, instanceId)
			const stored = instanceConfigStored.safeParse(saved?.document)
			return stored.success ? renderInstanceConfig(stored.data) : undefined
		},
		connect: async (host) => {
			if (!host.sshKeyId || !host.hostKeyFingerprint) {
				throw new Error(`Host ${host.id} is not ready to be collected from`)
			}
			const key = await sshKeys.findById({ organizationId: host.organizationId }, host.sshKeyId)
			if (!key) throw new Error(`Ssh key missing for host ${host.id}`)
			const transport = createSshTransport()
			await transport.connect({
				hostname: host.hostname,
				port: host.port,
				username: host.username,
				privateKey: secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId),
				expectedFingerprint: host.hostKeyFingerprint,
				timeoutMs: CONNECT_TIMEOUT_MS,
			})
			return transport
		},
		store: async (scope, values) => await artifacts.store(scope, values),
		storeAndAdvance: async (scope, values, advance) =>
			await artifacts.storeAndAdvance(scope, values, advance),
		resetCursor: async (scope, instanceId, version) =>
			await artifacts.resetCursor(scope, instanceId, version),
		deleteBeyondKept: async (scope, instanceId, kind, kept) =>
			await artifacts.deleteBeyondKept(scope, instanceId, kind, kept),
		deleteCollectedBefore: async (scope, cutoff) =>
			await artifacts.deleteCollectedBefore(scope, cutoff),
		now: () => new Date(),
		onError: runtimeErrorReporter(logger),
	})

	await boss.schedule(INSTANCE_ARTIFACT_QUEUE, "23 * * * *")
	await boss.work(
		INSTANCE_ARTIFACT_QUEUE,
		artifactCollectJob(collectArtifacts, artifactCollectReporter(logger)),
	)

	const updateStates = createUpdateStateRepository(db)
	const checkForUpdate = createUpdateCheck({
		build,
		readState: async () => await updateStates.find(),
		request: async (url) => await requestRelease(url),
		record: async (source, checkedAt, result) =>
			await updateStates.recordCheck(source, checkedAt, result),
		now: () => new Date(),
	})

	await boss.schedule(SYSTEM_UPDATE_CHECK_QUEUE, UPDATE_CHECK_CRON)
	await boss.work(
		SYSTEM_UPDATE_CHECK_QUEUE,
		updateCheckJob(checkForUpdate, updateCheckReporter(logger)),
	)

	await boss.work(NOTIFICATION_HTTP_QUEUE, workDeliveries(NOTIFICATION_HTTP_QUEUE))
	await boss.work(NOTIFICATION_EMAIL_QUEUE, workDeliveries(NOTIFICATION_EMAIL_QUEUE))

	const lastCheck = await updateStates.find()
	if (shouldCheckAtBoot(build, lastCheck?.checkedAt, new Date())) {
		await sendJob(SYSTEM_UPDATE_CHECK_QUEUE, {}, asSqlRunner(db))
	}

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

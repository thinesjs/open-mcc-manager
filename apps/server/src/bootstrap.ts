import type { serve } from "@hono/node-server"
import { trpcServer } from "@hono/trpc-server"
import { SIGN_IN_PATH } from "@open-mcc/contracts"
import {
	adminFor,
	attachQueueWarning,
	type BuildInfo,
	createAuditController,
	createAuditControllerTransaction,
	createCommandRepository,
	createDestinationController,
	createDestinationControllerTransaction,
	createHostController,
	createHostControllerTransaction,
	createHostRepository,
	createInstanceController,
	createInstanceControllerTransaction,
	createInstanceRepository,
	createNotificationRepository,
	createProcessIdentityRepository,
	createScheduleRepository,
	createSecretStore,
	createSelfHostController,
	createSshKeyController,
	createSshKeyControllerTransaction,
	createSshKeyRepository,
	createStatusController,
	createStatusControllerTransaction,
	createTaskRepository,
	drainConnectionChanges,
	egressPolicy,
	generateSshKeyPair,
	type HealthPollerHandle,
	hostList,
	hostReadKey,
	JOURNAL_READ_TIMEOUT_MS,
	LIVE_CONTROL_TIMEOUT_MS,
	type Logger,
	leaseHostReader,
	lockLostHandler,
	observeEachInstance,
	readBuildInfo,
	reconcileQueues,
	resolveMinecraftName,
	runtimeErrorReporter,
	type SchedulerHandle,
	type SendJob,
	scheduledRunFailure,
	startHealthPoller,
	startHeartbeat,
	startScheduler,
	startTaskScheduler,
	type TaskSchedulerHandle,
	tracedDialect,
	usesKnownInsecureKey,
} from "@open-mcc/core"
import { appliedSchemaVersion, createDb, type Db } from "@open-mcc/db"
import {
	createReadConnections,
	createRootSession,
	createSshTransport,
	probeHostKey,
	probeSshHandshake,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
} from "@open-mcc/transport"
import { Hono } from "hono"
import { PgBoss } from "pg-boss"
import { createAuth } from "./auth"
import { mountDashboardAuth } from "./auth-routes"
import { avatarHandler, defaultAvatarFetch, requireSession } from "./avatar"
import { createRequestContext } from "./create-context"
import type { Env } from "./env"
import { defaultIconFetch, itemIconHandler } from "./item-icon"
import { memberControllerFor } from "./members"
import { oidcProviderFrom, oidcWarningFor } from "./oidc-env"
import { applyRequestLimits } from "./request-limits"
import { requestSpan } from "./request-span"
import { appRouter } from "./routers/index"
import { requireSameOrigin, strictCors } from "./security/cors"
import { securityHeaders } from "./security/headers"
import {
	SELF_HOST_UNUSABLE_WARNING,
	selfHostConfigured,
	selfHostMaterialsFrom,
} from "./self-host-env"
import { acquireSingletonLock, type SingletonLock } from "./singleton"

export type ServerHandle = {
	app: Hono
	server: ReturnType<typeof serve>
	lock: SingletonLock
	db: Db
	scheduler: SchedulerHandle
	taskScheduler: TaskSchedulerHandle
	healthPoller: HealthPollerHandle
	boss: PgBoss
	heartbeat: { stop: () => void }
	build: BuildInfo
	schemaVersion: string
}

export type Serve = typeof serve

export const startServer = async (
	env: Env,
	serveFn: Serve,
	logger: Logger,
): Promise<ServerHandle> => {
	const secrets = await createSecretStore(env.SEALBOX_KEYS)

	const boss = new PgBoss({ connectionString: env.DATABASE_URL, supervise: false })
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
	const sendJob: SendJob = (queue, payload, runner, options) =>
		boss.send(queue, payload, {
			db: runner,
			...(options === undefined ? {} : { startAfter: options.startAfterSeconds }),
		})

	const db = createDb(env.DATABASE_URL, tracedDialect)
	const build = readBuildInfo(process.env)
	const schemaVersion = await appliedSchemaVersion(db)
	const identities = createProcessIdentityRepository(db)
	await identities.announce(
		{ role: "server", version: build.version, commit: build.commit, schemaVersion },
		new Date(),
	)
	const heartbeat = startHeartbeat(identities, "server")
	const allowed = env.ALLOWED_ORIGINS.split(",")
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0)
	const oidc = oidcProviderFrom(env)
	const oidcWarning = oidcWarningFor(env)
	if (oidcWarning !== undefined) logger.warn(oidcWarning)
	const dashboard = allowed.at(0)
	const auth = createAuth(db, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL, {
		userCreation: "closed",
		trustedOrigins: allowed,
		errorUrl: dashboard === undefined ? undefined : `${dashboard}${SIGN_IN_PATH}`,
		oidc,
	})
	const signupAuth = createAuth(db, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL, {
		disableSignUp: false,
		userCreation: "trusted",
		trustedOrigins: allowed,
	})

	if (usesKnownInsecureKey(env.SEALBOX_KEYS)) {
		logger.warn(
			"WARNING: SEALBOX_KEYS uses the publicly known development key. Every secret sealed with it is readable by anyone with this repository. Generate a real key before storing any host credential.",
		)
	}

	const lock = await acquireSingletonLock(env.DATABASE_URL, logger)
	if (!lock.acquired) {
		await lock.release()
		await db.destroy()
		throw new Error("Another control-plane replica holds the singleton lock")
	}

	const hosts = createHostRepository(db)
	const sshKeys = createSshKeyRepository(db)
	const readConnections = createReadConnections({
		createTransport: createSshTransport,
		idleMs: READ_CONNECTION_IDLE_MS,
		hardAgeMs: READ_CONNECTION_HARD_AGE_MS,
		channelLimit: READ_CONNECTION_CHANNEL_LIMIT,
		now: () => Date.now(),
	})
	const hostController = createHostController({
		hosts,
		sshKeys,
		secrets,
		probeHostKey,
		probeSshHandshake,
		createTransport: createSshTransport,
		createRootSession,
		now: () => new Date(),
		evictHost: (organizationId, hostId) =>
			readConnections.evict(hostReadKey(organizationId, hostId)),
		withTransaction: createHostControllerTransaction(db, sendJob),
		onError: runtimeErrorReporter(logger),
	})
	const statusController = createStatusController({
		withTransaction: createStatusControllerTransaction(db),
		sendJob,
		hostNames: async (scope) =>
			(await hosts.list(scope)).map((host) => ({ id: host.id, name: host.name })),
		instanceNames: async (scope) =>
			(await createInstanceRepository(db).list(scope)).map((row) => ({
				id: row.id,
				name: row.name,
			})),
		retentionDays: env.STATUS_RETENTION_DAYS,
		now: () => new Date(),
	})

	const instanceController = createInstanceController({
		instances: createInstanceRepository(db),
		schedules: createScheduleRepository(db),
		commands: createCommandRepository(db),
		hosts,
		sshKeys,
		secrets,
		createTransport: createSshTransport,
		readConnections,
		withTransaction: createInstanceControllerTransaction(db),
		now: () => Date.now(),
	})
	const destinationController = createDestinationController({
		withTransaction: createDestinationControllerTransaction(db),
		notifications: createNotificationRepository(db),
		secrets,
		sendJob,
		policy: egressPolicy({
			allowHttp: env.NOTIFICATION_ALLOW_HTTP,
			allowedHosts: env.NOTIFICATION_ALLOWED_HOSTS,
			allowedAddresses: env.NOTIFICATION_ALLOWED_ADDRESSES,
		}),
		teamsHosts: hostList(env.NOTIFICATION_TEAMS_HOSTS),
	})

	const withSshKeyTransaction = createSshKeyControllerTransaction(db)
	const sshKeyController = createSshKeyController({
		sshKeys,
		secrets,
		generateKeyPair: generateSshKeyPair,
		withTransaction: withSshKeyTransaction,
	})

	const auditController = createAuditController({
		withTransaction: createAuditControllerTransaction(db),
	})

	const selfHostMaterials = selfHostMaterialsFrom(env)
	if (!selfHostMaterials && selfHostConfigured(env)) logger.warn(SELF_HOST_UNUSABLE_WARNING)
	const selfHostController = createSelfHostController({
		materials: selfHostMaterials,
		sshKeys,
		withSshKeyTransaction,
		enroll: hostController.enroll,
	})

	const app = new Hono()
	app.use("*", requestSpan())
	app.use("*", securityHeaders())
	app.use("*", strictCors(allowed))
	app.use("*", requireSameOrigin(allowed))
	applyRequestLimits(app)

	app.get("/healthz", (c) => c.json({ ok: true, version: build.version, commit: build.commit }))
	app.get("/api/avatars/:username", requireSession(auth), avatarHandler(defaultAvatarFetch))
	app.get("/api/item-icons/:slug", requireSession(auth), itemIconHandler(defaultIconFetch))
	mountDashboardAuth(app, auth, { oidc: oidc !== undefined })
	app.use(
		"/trpc/*",
		trpcServer({
			router: appRouter,
			createContext: createRequestContext({
				auth,
				signupAuth,
				singleSignOn: oidc ? { name: oidc.name } : null,
				databaseUrl: env.DATABASE_URL,
				db,
				hostController,
				processIdentities: identities,
				build,
				schemaVersion,
				instanceController,
				statusController,
				sshKeyController,
				selfHostController,
				destinationController,
				memberController: memberControllerFor(db, auth, runtimeErrorReporter(logger)),
				auditController,
			}),
		}),
	)

	const server = serveFn({ fetch: app.fetch, port: env.PORT })

	lock.onLost(
		lockLostHandler(
			logger,
			() => server.close(),
			() => process.exit(1),
		),
	)

	const commands = createCommandRepository(db)
	const tasks = createTaskRepository(db)
	const scheduler = startScheduler({
		dueCommands: () => commands.listEnabledAcrossOrganizations(),
		send: (row) => instanceController.runScheduledCommand(row),
		describeFailure: scheduledRunFailure,
		claimRun: (id, ranAt, notRunSince) => commands.claimRun(id, ranAt, notRunSince),
		recordRun: (id, ranAt, error) => commands.recordRun(id, ranAt, error),
		now: () => new Date(),
		onError: runtimeErrorReporter(logger),
	})

	const taskScheduler = startTaskScheduler({
		enabledTasks: (runsSince) => tasks.listEnabledAcrossOrganizations(runsSince),
		isRunning: async (scope, instanceId) =>
			(await createInstanceRepository(db).findById(scope, instanceId))?.status === "running",
		observeSignals: (scope, instanceId, needs, at) =>
			instanceController.observeTaskSignals(scope, instanceId, needs, at),
		signalsSince: (scope, instanceId, since) => tasks.signalsSince(scope, instanceId, since),
		armInterval: (scope, taskId, arm) => tasks.armInterval(scope, taskId, arm),
		claimRun: (scope, taskId, claim, at) =>
			tasks.claimRun(scope, taskId, claim.trigger, claim.claimKey, at),
		send: (parts) => instanceController.runTask(parts),
		finishRun: (scope, runId, outcome, stepsSent, error, at) =>
			tasks.finishRun(scope, runId, outcome, stepsSent, error, at),
		recordTaskOutcome: (scope, taskId, ranAt, error) =>
			tasks.recordTaskOutcome(scope, taskId, ranAt, error),
		sweep: async (abandonBefore, pruneBefore, reason) => {
			await tasks.abandonStaleRuns(abandonBefore, reason)
			await tasks.pruneRuns(pruneBefore)
			await tasks.pruneSignals(pruneBefore)
		},
		describeFailure: scheduledRunFailure,
		now: () => new Date(),
		onError: runtimeErrorReporter(logger),
	})

	const readerDeps = { hosts, sshKeys, secrets, readConnections }
	const healthPoller = startHealthPoller({
		pollableHosts: () => hosts.listPollableAcrossOrganizations(),
		lease: (host, deadlineMs) =>
			leaseHostReader(
				readerDeps,
				{ organizationId: host.organizationId },
				host.id,
				deadlineMs,
				"runtime",
			),
		recordSeen: (host, seenAt, observed) =>
			hosts.recordSeen(host.id, host.organizationId, seenAt, observed),
		recordReachability: (host, reached) =>
			statusController.recordHostReachability(
				{ organizationId: host.organizationId },
				{ hostId: host.id, hostName: host.name, reached },
			),
		observeInstances: async (host, lease) => {
			const scope = { organizationId: host.organizationId }
			const onHost = (await createInstanceRepository(db).list(scope)).filter(
				(instance) => instance.hostId === host.id && instance.status !== "needs_auth",
			)
			await observeEachInstance(onHost, {
				observe: async (instance) => {
					const cursor = await statusController.connectionCursor(scope, instance.id)
					const current = await statusController.currentConnection(scope, instance.id)
					const outcome = await drainConnectionChanges(
						{
							lease: async () => {
								const journal = await lease(JOURNAL_READ_TIMEOUT_MS)
								return journal.kind === "leased" ? journal.reader : undefined
							},
							record: (changes) =>
								statusController.recordInstanceConnection(
									scope,
									{ id: instance.id, name: instance.name },
									changes,
								),
							saveCursor: (next) => statusController.saveConnectionCursor(scope, instance.id, next),
							onRefused: (refused) =>
								logger.warn(
									"Journal position no longer usable, reading this bot's journal afresh",
									{
										instanceId: instance.id,
										instanceName: instance.name,
										cursor: refused,
									},
								),
						},
						instance.id,
						current,
						cursor,
					)
					if (outcome === "unleased") return outcome
					const resolved = await resolveMinecraftName(instance, {
						latestConfig: (id) => createInstanceRepository(db).latestConfig(scope, id),
						openToken: (sealed, keyId) => secrets.open(sealed, keyId),
						reader: async () => {
							const leased = await lease(LIVE_CONTROL_TIMEOUT_MS)
							return leased.kind === "leased" ? leased.reader : undefined
						},
					})
					if (resolved !== undefined && resolved !== instance.minecraftUsername) {
						await createInstanceRepository(db)
							.update(scope, instance.id, { minecraftUsername: resolved })
							.catch(() => undefined)
					}
					return outcome
				},
				onFailed: (instance, error) =>
					runtimeErrorReporter(logger)(
						`Could not read bot ${instance.id} on host ${host.id}`,
						error,
					),
			})
		},
		now: () => new Date(),
		onError: runtimeErrorReporter(logger),
	})

	return {
		app,
		server,
		lock,
		db,
		scheduler,
		taskScheduler,
		healthPoller,
		boss,
		heartbeat,
		build,
		schemaVersion,
	}
}

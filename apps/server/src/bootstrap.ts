import type { serve } from "@hono/node-server"
import { trpcServer } from "@hono/trpc-server"
import {
	adminFor,
	type BuildInfo,
	CONNECT_TIMEOUT_MS,
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
	createSshKeyController,
	createSshKeyControllerTransaction,
	createSshKeyRepository,
	createStatusController,
	createStatusControllerTransaction,
	egressPolicy,
	generateSshKeyPair,
	type HealthPollerHandle,
	HOST_TEARDOWN_QUEUE,
	profileFrom,
	readBuildInfo,
	readConnectionChanges,
	reconcileQueues,
	redactError,
	resolveMinecraftName,
	type SchedulerHandle,
	type SendJob,
	startHealthPoller,
	startHeartbeat,
	startScheduler,
	usesKnownInsecureKey,
} from "@open-mcc/core"
import { appliedSchemaVersion, createDb, type Db } from "@open-mcc/db"
import { createSshTransport, probeHostKey } from "@open-mcc/transport"
import { Hono } from "hono"
import { PgBoss } from "pg-boss"
import { createAuth } from "./auth"
import { avatarHandler, defaultAvatarFetch, requireSession } from "./avatar"
import { createRequestContext } from "./create-context"
import type { Env } from "./env"
import { defaultIconFetch, itemIconHandler } from "./item-icon"
import { appRouter } from "./routers/index"
import { requireSameOrigin, strictCors } from "./security/cors"
import { securityHeaders } from "./security/headers"
import { acquireSingletonLock, type SingletonLock } from "./singleton"

export type ServerHandle = {
	app: Hono
	server: ReturnType<typeof serve>
	lock: SingletonLock
	db: Db
	scheduler: SchedulerHandle
	healthPoller: HealthPollerHandle
	boss: PgBoss
	heartbeat: { stop: () => void }
	build: BuildInfo
	schemaVersion: string
}

export type Serve = typeof serve

export const startServer = async (env: Env, serveFn: Serve): Promise<ServerHandle> => {
	const secrets = await createSecretStore(env.SEALBOX_KEYS)

	const boss = new PgBoss({ connectionString: env.DATABASE_URL, supervise: false })
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
	const sendJob: SendJob = (queue, payload, runner, options) =>
		boss.send(queue, payload, {
			db: runner,
			...(options === undefined ? {} : { startAfter: options.startAfterSeconds }),
		})

	const db = createDb(env.DATABASE_URL)
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
	const auth = createAuth(db, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL, {
		trustedOrigins: allowed,
	})
	const signupAuth = createAuth(db, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL, {
		disableSignUp: false,
		trustedOrigins: allowed,
	})

	if (usesKnownInsecureKey(env.SEALBOX_KEYS)) {
		console.warn(
			"WARNING: SEALBOX_KEYS uses the publicly known development key. Every secret sealed with it is readable by anyone with this repository. Generate a real key before storing any host credential.",
		)
	}

	const lock = await acquireSingletonLock(env.DATABASE_URL)
	if (!lock.acquired) {
		await lock.release()
		await db.destroy()
		throw new Error("Another control-plane replica holds the singleton lock")
	}

	const hosts = createHostRepository(db)
	const sshKeys = createSshKeyRepository(db)
	const hostController = createHostController({
		hosts,
		sshKeys,
		secrets,
		probeHostKey,
		createTransport: createSshTransport,
		now: () => new Date(),
		instanceIdsOnHost: async (scope, hostId) =>
			(await createInstanceRepository(db).list(scope))
				.filter((instance) => instance.hostId === hostId)
				.map((instance) => instance.id),
		withTransaction: createHostControllerTransaction(db, sendJob),
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
		withTransaction: createInstanceControllerTransaction(db),
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
	})

	const sshKeyController = createSshKeyController({
		sshKeys,
		secrets,
		generateKeyPair: generateSshKeyPair,
		withTransaction: createSshKeyControllerTransaction(db),
	})

	const app = new Hono()
	app.use("*", securityHeaders())
	app.use("*", strictCors(allowed))
	app.use("*", requireSameOrigin(allowed))

	app.get("/healthz", (c) => c.json({ ok: true, version: build.version, commit: build.commit }))
	app.get("/api/avatars/:username", requireSession(auth), avatarHandler(defaultAvatarFetch))
	app.get("/api/item-icons/:slug", requireSession(auth), itemIconHandler(defaultIconFetch))
	app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
	app.use(
		"/trpc/*",
		trpcServer({
			router: appRouter,
			createContext: createRequestContext({
				auth,
				signupAuth,
				db,
				hostController,
				processIdentities: identities,
				build,
				schemaVersion,
				instanceController,
				statusController,
				sshKeyController,
				destinationController,
			}),
		}),
	)

	const server = serveFn({ fetch: app.fetch, port: env.PORT })

	lock.onLost(() => {
		console.error("Singleton lock lost; quiescing and exiting")
		server.close()
		process.exit(1)
	})

	const commands = createCommandRepository(db)
	const scheduler = startScheduler({
		dueCommands: () => commands.listEnabledAcrossOrganizations(),
		send: (row) => instanceController.runScheduledCommand(row),
		claimRun: (id, ranAt, notRunSince) => commands.claimRun(id, ranAt, notRunSince),
		recordRun: (id, ranAt, error) => commands.recordRun(id, ranAt, error),
		now: () => new Date(),
		onError: (message, error) => {
			console.error(message, error instanceof Error ? redactError(error) : message)
		},
	})

	const healthPoller = startHealthPoller({
		pollableHosts: () => hosts.listPollableAcrossOrganizations(),
		connect: async (host) => {
			if (!host.sshKeyId || !host.hostKeyFingerprint) {
				throw new Error(`Host ${host.id} is not ready to be polled`)
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
		recordSeen: (host, seenAt, observed) =>
			hosts.recordSeen(host.id, host.organizationId, seenAt, observed),
		recordReachability: (host, reached) =>
			statusController.recordHostReachability(
				{ organizationId: host.organizationId },
				{ hostId: host.id, hostName: host.name, reached },
			),
		observeInstances: async (host, transport) => {
			if (!host.instancesRoot || !host.unitDir) return
			const scope = { organizationId: host.organizationId }
			const profile = profileFrom(host.mode, host.instancesRoot, host.unitDir)
			const onHost = (await createInstanceRepository(db).list(scope)).filter(
				(instance) => instance.hostId === host.id && instance.status !== "needs_auth",
			)
			for (const instance of onHost) {
				const cursor = await statusController.connectionCursor(scope, instance.id)
				const current = await statusController.currentConnection(scope, instance.id)
				const reading = await readConnectionChanges(
					transport,
					profile,
					instance.id,
					current,
					cursor,
				)
				await statusController.recordInstanceConnection(
					scope,
					{ id: instance.id, name: instance.name },
					reading.changes,
				)
				if (reading.cursor !== null && reading.cursor !== cursor) {
					await statusController.saveConnectionCursor(scope, instance.id, reading.cursor)
				}
				const resolved = await resolveMinecraftName(instance, transport, {
					latestConfig: (id) => createInstanceRepository(db).latestConfig(scope, id),
					openToken: (sealed, keyId) => secrets.open(sealed, keyId),
				})
				if (resolved !== undefined && resolved !== instance.minecraftUsername) {
					await createInstanceRepository(db)
						.update(scope, instance.id, { minecraftUsername: resolved })
						.catch(() => undefined)
				}
			}
		},
		now: () => new Date(),
		onError: (message, error) => {
			console.error(message, error instanceof Error ? redactError(error) : message)
		},
	})

	return { app, server, lock, db, scheduler, healthPoller, boss, heartbeat, build, schemaVersion }
}

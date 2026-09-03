import type { serve } from "@hono/node-server"
import { trpcServer } from "@hono/trpc-server"
import {
	assertInstancesRootMatchesUnitTemplate,
	createCommandRepository,
	createHostController,
	createHostControllerTransaction,
	createHostRepository,
	createInstanceController,
	createInstanceControllerTransaction,
	createInstanceRepository,
	createScheduleRepository,
	createSecretStore,
	createSshKeyController,
	createSshKeyControllerTransaction,
	createSshKeyRepository,
	generateSshKeyPair,
	redactError,
	type SchedulerHandle,
	startScheduler,
	usesKnownInsecureKey,
	validateInstancesRoot,
} from "@open-mcc/core"
import { createDb, type Db } from "@open-mcc/db"
import { createSshTransport, probeHostKey } from "@open-mcc/transport"
import { Hono } from "hono"
import { createAuth } from "./auth"
import { createRequestContext } from "./create-context"
import type { Env } from "./env"
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
}

export type Serve = typeof serve

export const startServer = async (env: Env, serveFn: Serve): Promise<ServerHandle> => {
	const instancesRoot = assertInstancesRootMatchesUnitTemplate(
		validateInstancesRoot(env.INSTANCES_ROOT),
	)
	const secrets = await createSecretStore(env.SEALBOX_KEYS)

	const db = createDb(env.DATABASE_URL)
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
		instancesRoot,
		withTransaction: createHostControllerTransaction(db),
	})
	const instanceController = createInstanceController({
		instances: createInstanceRepository(db),
		schedules: createScheduleRepository(db),
		commands: createCommandRepository(db),
		hosts,
		sshKeys,
		secrets,
		createTransport: createSshTransport,
		instancesRoot,
		withTransaction: createInstanceControllerTransaction(db),
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

	app.get("/healthz", (c) => c.json({ ok: true }))
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
				instanceController,
				sshKeyController,
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
		recordRun: (id, ranAt, error) => commands.recordRun(id, ranAt, error),
		now: () => new Date(),
		onError: (message, error) => {
			console.error(message, error instanceof Error ? redactError(error) : message)
		},
	})

	return { app, server, lock, db, scheduler }
}

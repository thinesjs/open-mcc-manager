import type { serve } from "@hono/node-server"
import { trpcServer } from "@hono/trpc-server"
import {
	createHostController,
	createHostControllerTransaction,
	createHostRepository,
	createSecretStore,
	createSshKeyController,
	createSshKeyControllerTransaction,
	createSshKeyRepository,
	generateSshKeyPair,
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
}

export type Serve = typeof serve

export const startServer = async (env: Env, serveFn: Serve): Promise<ServerHandle> => {
	const secrets = await createSecretStore(env.SEALBOX_KEYS)

	const db = createDb(env.DATABASE_URL)
	const auth = createAuth(db, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL)
	const signupAuth = createAuth(db, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL, {
		disableSignUp: false,
	})

	const lock = await acquireSingletonLock(env.DATABASE_URL)
	if (!lock.acquired) {
		await lock.release()
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
		instancesRoot: env.INSTANCES_ROOT,
		withTransaction: createHostControllerTransaction(db),
	})
	const sshKeyController = createSshKeyController({
		sshKeys,
		secrets,
		generateKeyPair: generateSshKeyPair,
		withTransaction: createSshKeyControllerTransaction(db),
	})

	const allowed = env.ALLOWED_ORIGINS.split(",")
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0)

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

	return { app, server, lock, db }
}

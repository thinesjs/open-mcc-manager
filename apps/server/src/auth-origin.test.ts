import { generateKeyPair } from "@open-mcc/core"
import { createDb, type Db } from "@open-mcc/db"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAuth } from "./auth"
import { type ServerHandle, startServer } from "./bootstrap"
import type { Env } from "./env"

const DASHBOARD_ORIGIN = "http://localhost:5173"
const SIGN_IN_BODY = JSON.stringify({
	email: "nobody@example.com",
	password: "correct horse battery staple 9",
})

let handle: ServerHandle | undefined
let db: Db | undefined

afterEach(async () => {
	if (handle) {
		await handle.lock.release()
		await handle.db.destroy()
		handle = undefined
	}
	if (db) {
		await db.destroy()
		db = undefined
	}
})

const startWithAllowedOrigins = async (allowedOrigins: string): Promise<ServerHandle> => {
	const env: Env = {
		DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
		PORT: 0,
		STATUS_RETENTION_DAYS: 30,
		BETTER_AUTH_SECRET: "a-very-long-test-secret-value-000000",
		BETTER_AUTH_URL: "http://localhost:3000",
		SEALBOX_KEYS: await generateKeyPair("k1"),
		ALLOWED_ORIGINS: allowedOrigins,
		NOTIFICATION_ALLOW_HTTP: false,
		NOTIFICATION_ALLOWED_HOSTS: "",
		NOTIFICATION_ALLOWED_ADDRESSES: "",
		NOTIFICATION_TEAMS_HOSTS: "",
	}
	handle = await startServer(env, vi.fn())
	return handle
}

const signIn = async (app: Hono, origin: string): Promise<Response> =>
	app.request("/api/auth/sign-in/email", {
		method: "POST",
		headers: { "content-type": "application/json", Origin: origin },
		body: SIGN_IN_BODY,
	})

describe("better-auth trusted origins", () => {
	it("lets a dashboard origin the deployment allows authenticate against the mounted handler", async () => {
		const started = await startWithAllowedOrigins(DASHBOARD_ORIGIN)

		const res = await signIn(started.app, DASHBOARD_ORIGIN)
		const body = await res.text()

		expect(body).not.toContain("INVALID_ORIGIN")
		expect(res.status, body).toBe(401)
	})

	it("refuses an origin the deployment does not allow, proving the check is live outside production", async () => {
		db = createDb(process.env.TEST_DATABASE_URL ?? "")
		const auth = createAuth(db, "a-very-long-test-secret-value-000000", "http://localhost:3000", {
			trustedOrigins: [],
			disableRateLimit: true,
		})
		const app = new Hono()
		app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))

		const res = await signIn(app, DASHBOARD_ORIGIN)
		const body = await res.text()

		expect(res.status, body).toBe(403)
		expect(body).toContain("INVALID_ORIGIN")
	})
})

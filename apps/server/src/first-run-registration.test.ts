import { randomUUID } from "node:crypto"
import { REGISTRATION_CLOSED_MESSAGE } from "@open-mcc/contracts"
import { createLogger, generateKeyPair } from "@open-mcc/core"
import { createDb, type Db, migrateToLatest } from "@open-mcc/db"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { type ServerHandle, startServer } from "./bootstrap"
import type { Env } from "./env"

vi.mock("@open-mcc/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@open-mcc/core")>()
	return {
		...actual,
		startScheduler: () => ({ stop: () => undefined }),
		startHealthPoller: () => ({ stop: () => undefined }),
	}
})

const STARTUP_TIMEOUT_MS = 60_000

const ORIGIN = "http://localhost:5173"
const BASE_URL = "http://localhost:3000"
const SECRET = "a-very-long-test-secret-value-000000"
const PASSWORD = "correct horse battery staple 7"
const OWNER_NAME = "First Owner"
const ORGANIZATION_NAME = "Aperture Science"

const adminUrl = process.env.TEST_DATABASE_URL ?? ""
const databaseName = `first_run_${randomUUID().replaceAll("-", "")}`

const onConnection = async (connectionString: string, statement: string): Promise<void> => {
	const client = new Client({ connectionString })
	await client.connect()
	try {
		await client.query(statement)
	} finally {
		await client.end()
	}
}

const signInOptionsSchema = z.object({
	result: z.object({
		data: z.object({ registrationOpen: z.boolean() }),
	}),
})

const refusalSchema = z.object({
	error: z.object({
		message: z.string(),
		data: z.object({ errorCode: z.string(), httpStatus: z.number() }),
	}),
})

let handle: ServerHandle
let db: Db
let databaseUrl: string
let ownerEmail: string

const env = async (): Promise<Env> => ({
	DATABASE_URL: databaseUrl,
	PORT: 0,
	STATUS_RETENTION_DAYS: 30,
	BETTER_AUTH_SECRET: SECRET,
	BETTER_AUTH_URL: BASE_URL,
	SEALBOX_KEYS: await generateKeyPair("k1"),
	ALLOWED_ORIGINS: ORIGIN,
	NOTIFICATION_ALLOW_HTTP: false,
	NOTIFICATION_ALLOWED_HOSTS: "",
	NOTIFICATION_ALLOWED_ADDRESSES: "",
	NOTIFICATION_TEAMS_HOSTS: "",
	OTEL_EXPORTER_OTLP_ENDPOINT: "",
})

const post = async (path: string, body: Record<string, string>): Promise<Response> =>
	await handle.app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json", Origin: ORIGIN },
		body: JSON.stringify(body),
	})

const registrationOpen = async (): Promise<boolean> => {
	const res = await handle.app.request("/trpc/system.signInOptions", {
		headers: { Origin: ORIGIN },
	})
	expect(res.status, await res.clone().text()).toBe(200)
	return signInOptionsSchema.parse(await res.json()).result.data.registrationOpen
}

const register = async (email: string): Promise<Response> =>
	await post("/trpc/member.registerFirstOwner", {
		email,
		password: PASSWORD,
		name: OWNER_NAME,
		organizationName: ORGANIZATION_NAME,
	})

const users = async () => await db.selectFrom("user").select(["id", "email", "name"]).execute()

beforeAll(async () => {
	await onConnection(adminUrl, `create database "${databaseName}"`)
	const url = new URL(adminUrl)
	url.pathname = `/${databaseName}`
	databaseUrl = url.toString()
	db = createDb(databaseUrl)
	const migrated = await migrateToLatest(db)
	if (migrated.error) throw migrated.error
	ownerEmail = `${randomUUID()}@example.com`
	handle = await startServer(await env(), vi.fn(), createLogger({ write: () => undefined }))
}, STARTUP_TIMEOUT_MS)

afterAll(async () => {
	handle.scheduler.stop()
	handle.healthPoller.stop()
	handle.heartbeat.stop()
	await handle.boss.stop({ graceful: false })
	await handle.lock.release()
	await handle.db.destroy()
	await db.destroy()
	await onConnection(adminUrl, `drop database "${databaseName}" with (force)`)
})

describe("registering the first owner of a deployment", () => {
	it("offers registration while this deployment has no owner, and mounts no sign-up endpoint by doing so", async () => {
		expect(await users()).toEqual([])
		expect(await registrationOpen()).toBe(true)

		const stranger = `${randomUUID()}@example.com`
		const res = await post("/api/auth/sign-up/email", {
			email: stranger,
			password: PASSWORD,
			name: "Uninvited",
		})

		expect(res.status).not.toBe(200)
		expect(await users()).toEqual([])
	})

	it("creates that owner, their organization and their membership as its owner", async () => {
		const res = await register(ownerEmail)

		expect(res.status, await res.clone().text()).toBe(200)
		const created = await db
			.selectFrom("user")
			.select(["id", "name"])
			.where("email", "=", ownerEmail)
			.executeTakeFirstOrThrow()
		expect(created.name).toBe(OWNER_NAME)
		const organization = await db
			.selectFrom("organization")
			.select(["id", "name"])
			.executeTakeFirstOrThrow()
		expect(organization.name).toBe(ORGANIZATION_NAME)
		const membership = await db
			.selectFrom("member")
			.select(["role", "organizationId"])
			.where("userId", "=", created.id)
			.executeTakeFirstOrThrow()
		expect(membership.role).toBe("owner")
		expect(membership.organizationId).toBe(organization.id)
	})

	it("closes registration for good once that owner exists, and says so in words an operator can act on", async () => {
		expect(await registrationOpen()).toBe(false)

		const res = await register(`${randomUUID()}@example.com`)
		const refusal = refusalSchema.parse(await res.clone().json())

		expect(res.status).toBe(403)
		expect(refusal.error.data.errorCode).toBe("REGISTRATION_CLOSED")
		expect(refusal.error.message).toBe(REGISTRATION_CLOSED_MESSAGE)
		expect(await users()).toHaveLength(1)
	})

	it("still mounts no sign-up endpoint now that an owner exists", async () => {
		const res = await post("/api/auth/sign-up/email", {
			email: `${randomUUID()}@example.com`,
			password: PASSWORD,
			name: "Uninvited",
		})

		expect(res.status).not.toBe(200)
		expect(await users()).toHaveLength(1)
	})

	it("signs that owner in with the password they chose", async () => {
		const res = await post("/api/auth/sign-in/email", { email: ownerEmail, password: PASSWORD })

		expect(res.status, await res.clone().text()).toBe(200)
	})
})

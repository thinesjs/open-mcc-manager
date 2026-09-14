import { randomUUID } from "node:crypto"
import { readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "pg"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createDb } from "./client"
import { DrizzleHistoryWithoutBaselineError, migrateToLatest } from "./migrator"

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations")

const migrationFileNames = (): string[] =>
	readdirSync(MIGRATIONS_DIR)
		.filter((file) => file.endsWith(".sql"))
		.sort()

const requireTestDatabaseUrl = (): string => {
	const url = process.env.TEST_DATABASE_URL
	if (!url) throw new Error("TEST_DATABASE_URL is required to run repository tests")
	return url
}

const ADMIN_URL = requireTestDatabaseUrl()
const DATABASE_NAME = `migrator_test_${randomUUID().replaceAll("-", "")}`

let databaseUrl: string

beforeAll(async () => {
	const admin = new Client({ connectionString: ADMIN_URL })
	await admin.connect()
	await admin.query(`create database "${DATABASE_NAME}"`)
	await admin.end()

	const url = new URL(ADMIN_URL)
	url.pathname = `/${DATABASE_NAME}`
	databaseUrl = url.toString()
})

afterEach(async () => {
	const client = new Client({ connectionString: databaseUrl })
	await client.connect()
	await client.query("drop schema if exists drizzle cascade")
	await client.query("drop schema public cascade")
	await client.query("create schema public")
	await client.end()
})

const SESSIONS_GONE_TIMEOUT_MS = 10_000

const openSessions = async (admin: Client): Promise<number> => {
	const result = await admin.query<{ open: number }>(
		"select count(*)::int as open from pg_stat_activity where datname = $1",
		[DATABASE_NAME],
	)
	return result.rows[0]?.open ?? 0
}

const untilSessionsGone = async (admin: Client): Promise<void> => {
	const deadline = Date.now() + SESSIONS_GONE_TIMEOUT_MS
	while ((await openSessions(admin)) > 0) {
		if (Date.now() > deadline) throw new Error(`sessions still open on ${DATABASE_NAME}`)
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}

afterAll(async () => {
	const admin = new Client({ connectionString: ADMIN_URL })
	await admin.connect()
	await untilSessionsGone(admin)
	await admin.query(`drop database "${DATABASE_NAME}"`)
	await admin.end()
})

const tableExists = async (schema: string, table: string): Promise<boolean> => {
	const client = new Client({ connectionString: databaseUrl })
	await client.connect()
	const result = await client.query("select to_regclass($1) is not null as exists", [
		`${schema}.${table}`,
	])
	await client.end()
	return result.rows[0].exists
}

describe("migrateToLatest drizzle-history guard", () => {
	it("aborts instead of replaying migrations when drizzle history exists without a kysely baseline", async () => {
		const setup = new Client({ connectionString: databaseUrl })
		await setup.connect()
		await setup.query("create schema drizzle")
		await setup.query(
			"create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)",
		)
		await setup.end()

		const db = createDb(databaseUrl)
		const { error, results } = await migrateToLatest(db)
		await db.destroy()

		expect(error).toBeInstanceOf(DrizzleHistoryWithoutBaselineError)
		expect(results).toBeUndefined()
		expect(await tableExists("public", "host")).toBe(false)
	})

	it("migrates a genuinely fresh database normally", async () => {
		const db = createDb(databaseUrl)
		const { error, results } = await migrateToLatest(db)
		await db.destroy()

		expect(error).toBeUndefined()
		expect(results?.length).toBeGreaterThan(0)
		expect(results?.every((result) => result.status === "Success")).toBe(true)
		expect(await tableExists("public", "host")).toBe(true)
	})

	it("passes through and no-ops when drizzle history exists and a kysely baseline already records it", async () => {
		const setup = new Client({ connectionString: databaseUrl })
		await setup.connect()
		await setup.query("create schema drizzle")
		await setup.query(
			"create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)",
		)
		await setup.query(
			"create table kysely_migration (name varchar(255) not null primary key, timestamp varchar(255) not null)",
		)
		await setup.query(
			"create table kysely_migration_lock (id varchar(255) not null primary key, is_locked integer not null default 0)",
		)
		await setup.query(
			"insert into kysely_migration_lock (id, is_locked) values ('migration_lock', 0)",
		)
		const names = migrationFileNames()
		const placeholders = names
			.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`)
			.join(", ")
		const values = names.flatMap((name) => [name, new Date().toISOString()])
		await setup.query(
			`insert into kysely_migration (name, timestamp) values ${placeholders}`,
			values,
		)
		await setup.end()

		const db = createDb(databaseUrl)
		const { error, results } = await migrateToLatest(db)
		await db.destroy()

		expect(error).toBeUndefined()
		expect(results).toEqual([])
		expect(await tableExists("public", "host")).toBe(false)
	})
})

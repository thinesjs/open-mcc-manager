import { randomUUID } from "node:crypto"
import { Client } from "pg"
import { describe, expect, it } from "vitest"
import { createDb } from "./client"
import { DrizzleHistoryWithoutBaselineError, migrateToLatest } from "./migrator"

const requireTestDatabaseUrl = (): string => {
	const url = process.env.TEST_DATABASE_URL
	if (!url) throw new Error("TEST_DATABASE_URL is required to run repository tests")
	return url
}

const ADMIN_URL = requireTestDatabaseUrl()

const withDisposableDatabase = async <T>(run: (databaseUrl: string) => Promise<T>): Promise<T> => {
	const name = `migrator_test_${randomUUID().replaceAll("-", "")}`

	const admin = new Client({ connectionString: ADMIN_URL })
	await admin.connect()
	await admin.query(`create database "${name}"`)
	await admin.end()

	const databaseUrl = new URL(ADMIN_URL)
	databaseUrl.pathname = `/${name}`

	try {
		return await run(databaseUrl.toString())
	} finally {
		const cleanup = new Client({ connectionString: ADMIN_URL })
		await cleanup.connect()
		await cleanup.query(`drop database "${name}" with (force)`)
		await cleanup.end()
	}
}

const tableExists = async (
	databaseUrl: string,
	schema: string,
	table: string,
): Promise<boolean> => {
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
		await withDisposableDatabase(async (databaseUrl) => {
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
			expect(await tableExists(databaseUrl, "public", "host")).toBe(false)
		})
	})

	it("migrates a genuinely fresh database normally", async () => {
		await withDisposableDatabase(async (databaseUrl) => {
			const db = createDb(databaseUrl)
			const { error, results } = await migrateToLatest(db)
			await db.destroy()

			expect(error).toBeUndefined()
			expect(results?.length).toBeGreaterThan(0)
			expect(results?.every((result) => result.status === "Success")).toBe(true)
			expect(await tableExists(databaseUrl, "public", "host")).toBe(true)
		})
	})
})

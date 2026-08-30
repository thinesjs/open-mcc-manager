import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "kysely"
import {
	type Migration,
	type MigrationProvider,
	type MigrationResultSet,
	Migrator,
} from "kysely/migration"
import type { Db } from "./client"

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations")
const STATEMENT_BREAKPOINT = "--> statement-breakpoint"

const splitStatements = (contents: string): string[] =>
	contents
		.split(STATEMENT_BREAKPOINT)
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0)

class SqlFileMigrationProvider implements MigrationProvider {
	async getMigrations(): Promise<Record<string, Migration>> {
		const files = readdirSync(MIGRATIONS_DIR)
			.filter((file) => file.endsWith(".sql"))
			.sort()

		const migrations: Record<string, Migration> = {}
		for (const file of files) {
			const statements = splitStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
			migrations[file] = {
				up: async (db: Db): Promise<void> => {
					for (const statement of statements) {
						await sql.raw(statement).execute(db)
					}
				},
			}
		}
		return migrations
	}
}

export const createMigrator = (db: Db): Migrator =>
	new Migrator({ db, provider: new SqlFileMigrationProvider() })

export class DrizzleHistoryWithoutBaselineError extends Error {
	constructor() {
		super(
			[
				"This database has a drizzle.__drizzle_migrations table but no kysely_migration table.",
				"It was migrated by drizzle-kit and has no Kysely migration history, so replaying",
				"migrations from 0000 would fail against tables that already exist.",
				"Point DATABASE_URL at a fresh database, or baseline this one by inserting the names",
				"of the already-applied migration files into a kysely_migration table",
				"(columns: name varchar primary key, timestamp varchar) before running this again.",
			].join(" "),
		)
		this.name = "DrizzleHistoryWithoutBaselineError"
	}
}

const tableExists = async (db: Db, qualifiedName: string): Promise<boolean> => {
	const result = await sql<{ tableExists: boolean }>`
		select to_regclass(${qualifiedName}) is not null as "tableExists"
	`.execute(db)
	return result.rows[0]?.tableExists ?? false
}

const assertNoUnbaselinedDrizzleHistory = async (db: Db): Promise<void> => {
	const hasDrizzleHistory = await tableExists(db, "drizzle.__drizzle_migrations")
	if (!hasDrizzleHistory) return
	const hasKyselyHistory = await tableExists(db, "public.kysely_migration")
	if (!hasKyselyHistory) throw new DrizzleHistoryWithoutBaselineError()
}

export const migrateToLatest = async (db: Db): Promise<MigrationResultSet> => {
	try {
		await assertNoUnbaselinedDrizzleHistory(db)
	} catch (error) {
		return { error }
	}
	return createMigrator(db).migrateToLatest()
}

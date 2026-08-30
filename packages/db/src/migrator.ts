import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "kysely"
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration"
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

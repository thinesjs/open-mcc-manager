import "@open-mcc/config/load-env.mjs"
import type { Db } from "./client"
import { createDb } from "./client"
import { migrateToLatest } from "./migrator"
import { waitForDatabase } from "./wait-for-database"

const run = async (): Promise<void> => {
	const url = process.env.DATABASE_URL
	if (!url) throw new Error("DATABASE_URL is required to run migrations")

	const db: Db = createDb(url)

	try {
		await waitForDatabase(db)
	} catch (error) {
		console.error(error)
		await db.destroy()
		process.exit(1)
	}

	const { error, results } = await migrateToLatest(db)

	for (const result of results ?? []) {
		if (result.status === "Error") {
			console.error(`migration "${result.migrationName}" failed`)
		}
	}

	await db.destroy()

	if (error) {
		console.error(error)
		process.exit(1)
	}
}

run()

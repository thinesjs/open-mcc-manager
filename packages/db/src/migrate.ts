import { createDb } from "./client"
import { migrateToLatest } from "./migrator"

const run = async (): Promise<void> => {
	const url = process.env.DATABASE_URL
	if (!url) throw new Error("DATABASE_URL is required to run migrations")

	const db = createDb(url)
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

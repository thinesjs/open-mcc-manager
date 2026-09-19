import "@open-mcc/config/load-env.mjs"
import { createDb, migrateToLatest } from "@open-mcc/db"

export default async function setup(): Promise<void> {
	const url = process.env.TEST_DATABASE_URL
	if (!url) throw new Error("TEST_DATABASE_URL is required to run worker tests")
	const db = createDb(url)
	try {
		const { error } = await migrateToLatest(db)
		if (error) throw error
	} finally {
		await db.destroy()
	}
}

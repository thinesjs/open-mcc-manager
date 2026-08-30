import { createDb } from "@open-mcc/db"
import { createAuth } from "./auth"
import { bootstrapOwner } from "./bootstrap-owner"
import { loadEnv } from "./env"

const readRequiredEnv = (name: string): string => {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is required to bootstrap the first owner`)
	return value
}

const run = async (): Promise<void> => {
	const env = loadEnv()
	const db = createDb(env.DATABASE_URL)
	const auth = createAuth(db, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL, {
		disableSignUp: false,
	})

	try {
		const result = await bootstrapOwner(db, auth, {
			email: readRequiredEnv("BOOTSTRAP_OWNER_EMAIL"),
			password: readRequiredEnv("BOOTSTRAP_OWNER_PASSWORD"),
			name: readRequiredEnv("BOOTSTRAP_OWNER_NAME"),
			organizationName: readRequiredEnv("BOOTSTRAP_ORG_NAME"),
			organizationSlug: readRequiredEnv("BOOTSTRAP_ORG_SLUG"),
		})
		console.error(`Bootstrapped owner ${result.userId} in organization ${result.organizationId}`)
	} finally {
		await db.destroy()
	}
}

run().catch((error: Error) => {
	console.error(error.message)
	process.exit(1)
})

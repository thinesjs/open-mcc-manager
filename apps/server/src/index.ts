import { serve } from "@hono/node-server"
import { startServer } from "./bootstrap"
import { loadEnv } from "./env"

startServer(loadEnv(), serve).catch((error: Error) => {
	console.error(error.message)
	process.exit(1)
})

import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { portFrom, startWebServer } from "./bootstrap"

const main = (): void => {
	startWebServer({
		root: fileURLToPath(new URL("dist/", import.meta.url)),
		port: portFrom(process.env.PORT),
		serveFn: serve,
	})
}

try {
	main()
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
	process.exit(1)
}

import "@open-mcc/config/load-env.mjs"
import { serve } from "@hono/node-server"
import { readBuildInfo, startTracing } from "@open-mcc/core"
import { startServer } from "./bootstrap"
import { loadEnv } from "./env"
import { rootLogger as logger, SERVICE } from "./root-logger"
import { GENERATE_KEY_FLAG, generateSealboxKeyFromArgv } from "./sealbox-key-argv"

export type { AppRouter } from "./routers/index"

const main = async (): Promise<void> => {
	if (process.argv.includes(GENERATE_KEY_FLAG)) {
		const entry = await generateSealboxKeyFromArgv(process.argv)
		process.stdout.write(`${entry}\n`)
		return
	}
	const env = loadEnv()
	const tracing = startTracing({
		service: SERVICE,
		version: readBuildInfo(process.env).version,
		endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
	})
	if (!tracing.active) {
		logger.warn(
			"OTEL_EXPORTER_OTLP_ENDPOINT is not set, so no traces are being sent. Logs will carry no trace id and a delivery cannot be followed across processes.",
		)
	}
	const flush = (): void => {
		void tracing.shutdown().then(() => process.exit(0))
	}
	process.on("SIGINT", flush)
	process.on("SIGTERM", flush)

	await startServer(env, serve, logger)
}

main().catch((error: Error) => {
	logger.error(error.message)
	process.exit(1)
})

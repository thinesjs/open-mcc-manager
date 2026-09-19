import { readBuildInfo, startTracing } from "@open-mcc/core"
import { startWorker } from "./bootstrap"
import { loadWorkerEnv } from "./env"
import { rootLogger as logger, SERVICE } from "./root-logger"

const main = async (): Promise<void> => {
	const env = loadWorkerEnv()
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
	const worker = await startWorker(env, logger)
	const stop = (): void => {
		void worker
			.stop()
			.then(() => tracing.shutdown())
			.then(() => process.exit(0))
	}
	process.on("SIGINT", stop)
	process.on("SIGTERM", stop)
}

main().catch((error: Error) => {
	logger.error("Worker failed to start", { detail: error.message })
	process.exit(1)
})

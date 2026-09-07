import "@open-mcc/config/load-env.mjs"
import { serve } from "@hono/node-server"
import { generateKeyPair, readBuildInfo, startTracing } from "@open-mcc/core"
import { startServer } from "./bootstrap"
import { loadEnv } from "./env"

export type { AppRouter } from "./routers/index"

export const GENERATE_KEY_FLAG = "--generate-sealbox-key"

export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const generateSealboxKeyFromArgv = async (argv: readonly string[]): Promise<string> => {
	const flagAt = argv.indexOf(GENERATE_KEY_FLAG)
	const keyId = argv[flagAt + 1] ?? "k1"
	if (!KEY_ID_PATTERN.test(keyId)) {
		throw new Error("Key id must be 1-64 characters of letters, digits, hyphens and underscores")
	}
	return await generateKeyPair(keyId)
}

const main = async (): Promise<void> => {
	if (process.argv.includes(GENERATE_KEY_FLAG)) {
		const entry = await generateSealboxKeyFromArgv(process.argv)
		process.stdout.write(`${entry}\n`)
		return
	}
	const env = loadEnv()
	const tracing = startTracing({
		service: "open-mcc-server",
		version: readBuildInfo(process.env).version,
		endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
	})
	if (!tracing.active) {
		console.warn(
			"OTEL_EXPORTER_OTLP_ENDPOINT is not set, so no traces are being sent. Logs will carry no trace id and a delivery cannot be followed across processes.",
		)
	}
	const flush = (): void => {
		void tracing.shutdown().then(() => process.exit(0))
	}
	process.on("SIGINT", flush)
	process.on("SIGTERM", flush)

	await startServer(env, serve)
}

main().catch((error: Error) => {
	console.error(error.message)
	process.exit(1)
})

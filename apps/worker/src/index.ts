import { startWorker } from "./bootstrap"
import { loadWorkerEnv } from "./env"

const main = async (): Promise<void> => {
	const worker = await startWorker(loadWorkerEnv())
	const stop = (): void => {
		worker.stop()
		process.exit(0)
	}
	process.on("SIGINT", stop)
	process.on("SIGTERM", stop)
}

main().catch((error) => {
	console.error("Worker failed to start", error)
	process.exit(1)
})

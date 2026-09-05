import { z } from "zod"

export const workerEnvSchema = z.object({
	DATABASE_URL: z.string().min(1),
	SEALBOX_KEYS: z.string().min(1),
	JOB_TICK_MS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),
})

export type WorkerEnv = z.infer<typeof workerEnvSchema>

export const loadWorkerEnv = (source: NodeJS.ProcessEnv = process.env): WorkerEnv =>
	workerEnvSchema.parse(source)

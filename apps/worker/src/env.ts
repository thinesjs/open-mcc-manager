import { z } from "zod"

export const workerEnvSchema = z.object({
	DATABASE_URL: z.string().min(1),
	SEALBOX_KEYS: z.string().min(1),
})

export type WorkerEnv = z.infer<typeof workerEnvSchema>

export const loadWorkerEnv = (source: NodeJS.ProcessEnv = process.env): WorkerEnv =>
	workerEnvSchema.parse(source)

import { z } from "zod"

const envSchema = z.object({
	DATABASE_URL: z.string().min(1),
	PORT: z.coerce.number().int().min(1).max(65535).default(3000),
	BETTER_AUTH_SECRET: z.string().min(16),
	BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
	SEALBOX_KEYS: z.string().min(1),
	ALLOWED_ORIGINS: z.string().min(1),
})

export type Env = z.infer<typeof envSchema>

export const loadEnv = (): Env => envSchema.parse(process.env)

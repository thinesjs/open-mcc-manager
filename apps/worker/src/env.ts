import { readsAsAddressList } from "@open-mcc/core"
import { z } from "zod"

const boolean = z.enum(["true", "false"]).transform((value) => value === "true")

const addressList = z
	.string()
	.refine(readsAsAddressList, "must be a comma-separated list of addresses or ranges")

export const workerEnvSchema = z.object({
	DATABASE_URL: z.string().min(1),
	SEALBOX_KEYS: z.string().min(1),
	STATUS_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
	NOTIFICATION_ALLOW_HTTP: boolean.default("false"),
	NOTIFICATION_ALLOWED_HOSTS: z.string().default(""),
	NOTIFICATION_ALLOWED_ADDRESSES: addressList.default(""),
	LOG_LEVEL: z.string().default("info"),
	OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(""),
})

export type WorkerEnv = z.infer<typeof workerEnvSchema>

export const loadWorkerEnv = (source: NodeJS.ProcessEnv = process.env): WorkerEnv =>
	workerEnvSchema.parse(source)

import { readsAsAddressList } from "@open-mcc/core"
import { z } from "zod"

const boolean = z.enum(["true", "false"]).transform((value) => value === "true")

const addressList = z
	.string()
	.refine(readsAsAddressList, "must be a comma-separated list of addresses or ranges")

const envSchema = z.object({
	DATABASE_URL: z.string().min(1),
	PORT: z.coerce.number().int().min(1).max(65535).default(3000),
	STATUS_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
	BETTER_AUTH_SECRET: z.string().min(16),
	BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
	SEALBOX_KEYS: z.string().min(1),
	ALLOWED_ORIGINS: z.string().min(1),
	NOTIFICATION_ALLOW_HTTP: boolean.default("false"),
	NOTIFICATION_ALLOWED_HOSTS: z.string().default(""),
	NOTIFICATION_ALLOWED_ADDRESSES: addressList.default(""),
	NOTIFICATION_TEAMS_HOSTS: z.string().default(""),
	OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(""),
	SELF_HOST_NAME: z.string().optional(),
	SELF_HOST_HOSTNAME: z.string().optional(),
	SELF_HOST_PORT: z.string().optional(),
	SELF_HOST_USERNAME: z.string().optional(),
	SELF_HOST_MODE: z.string().optional(),
	SELF_HOST_FINGERPRINT: z.string().optional(),
	SELF_HOST_PUBLIC_KEY: z.string().optional(),
	SELF_HOST_PRIVATE_KEY_SEALED: z.string().optional(),
	SELF_HOST_PRIVATE_KEY_ID: z.string().optional(),
	SELF_HOST_REACH: z.string().optional(),
	SELF_HOST_SYSTEMD: z.string().optional(),
	SELF_HOST_LINGER: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

export const loadEnv = (): Env => envSchema.parse(process.env)

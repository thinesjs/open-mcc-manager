import { selfHostOffer } from "@open-mcc/contracts"
import type { SelfHostMaterials } from "@open-mcc/core"
import { z } from "zod"
import type { Env } from "./env"

const materialsSchema = z.object({
	offer: selfHostOffer,
	publicKey: z.string().min(1),
	privateKeyEncrypted: z.string().min(1),
	privateKeyKeyId: z.string().min(1),
})

const SELF_HOST_FIELDS = [
	"SELF_HOST_NAME",
	"SELF_HOST_HOSTNAME",
	"SELF_HOST_PORT",
	"SELF_HOST_USERNAME",
	"SELF_HOST_FINGERPRINT",
	"SELF_HOST_PUBLIC_KEY",
	"SELF_HOST_PRIVATE_KEY_SEALED",
	"SELF_HOST_PRIVATE_KEY_ID",
	"SELF_HOST_REACH",
	"SELF_HOST_SYSTEMD",
	"SELF_HOST_LINGER",
] as const

const YES = "yes"

export const selfHostConfigured = (env: Env): boolean =>
	SELF_HOST_FIELDS.some((field) => (env[field] ?? "").trim().length > 0)

export const selfHostMaterialsFrom = (env: Env): SelfHostMaterials | undefined => {
	const parsed = materialsSchema.safeParse({
		offer: {
			name: env.SELF_HOST_NAME,
			hostname: env.SELF_HOST_HOSTNAME,
			port: Number.parseInt(env.SELF_HOST_PORT ?? "", 10),
			username: env.SELF_HOST_USERNAME,
			fingerprint: env.SELF_HOST_FINGERPRINT,
			reach: env.SELF_HOST_REACH,
			systemd: env.SELF_HOST_SYSTEMD === YES,
			linger: env.SELF_HOST_LINGER === YES,
		},
		publicKey: env.SELF_HOST_PUBLIC_KEY,
		privateKeyEncrypted: env.SELF_HOST_PRIVATE_KEY_SEALED,
		privateKeyKeyId: env.SELF_HOST_PRIVATE_KEY_ID,
	})
	return parsed.success ? parsed.data : undefined
}

export const SELF_HOST_UNUSABLE_WARNING =
	"SELF_HOST_* is set but does not describe a machine this deployment can enroll, so none is offered. Re-run scripts/self-host.sh and append .env.self-host to .env."

import { createHash } from "node:crypto"
import { z } from "zod"

const hostKeySchema = z.object({
	algorithm: z.string().min(1),
	fingerprint: z.string().min(1),
})

export type HostKey = z.infer<typeof hostKeySchema>

export const parseHostKey = (value: unknown): HostKey => hostKeySchema.parse(value)

export const fingerprintFromKey = (key: Buffer): string =>
	`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`

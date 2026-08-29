import { z } from "zod"

export const hostStatusSchema = z.enum(["pending", "provisioning", "ready", "unreachable", "error"])

export type HostStatus = z.infer<typeof hostStatusSchema>

export const createHostInput = z.object({
	name: z.string().min(1).max(64),
	hostname: z.string().min(1).max(255),
	port: z.number().int().min(1).max(65535).default(22),
	username: z.string().min(1).max(64).default("root"),
	sshKeyId: z.string().min(1),
	expectedFingerprint: z
		.string()
		.regex(/^SHA256:[A-Za-z0-9+/]{43}$/, "Expected an OpenSSH SHA256 fingerprint"),
})

export type CreateHostInput = z.infer<typeof createHostInput>

export const hostIdInput = z.object({ hostId: z.string().min(1) })
export type HostIdInput = z.infer<typeof hostIdInput>

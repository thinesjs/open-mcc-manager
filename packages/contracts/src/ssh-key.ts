import { z } from "zod"

export const createSshKeyInput = z.object({
	name: z.string().min(1).max(64),
	type: z.literal("ed25519").default("ed25519"),
})

export type CreateSshKeyInput = z.infer<typeof createSshKeyInput>

export const sshKeyPublic = z.object({
	id: z.string(),
	name: z.string(),
	publicKey: z.string(),
	createdAt: z.date(),
})

export type SshKeyPublic = z.infer<typeof sshKeyPublic>

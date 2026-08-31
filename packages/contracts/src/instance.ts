import { z } from "zod"

export const instanceStatusSchema = z.enum(["created", "needs_auth", "stopped", "running", "error"])
export type InstanceStatus = z.infer<typeof instanceStatusSchema>

export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const createInstanceInput = z.object({
	hostId: z.string().min(1),
	name: z.string().min(1).max(64),
	minecraftAccount: z.string().email(),
	serverAddress: z.string().min(1).max(253),
})
export type CreateInstanceInput = z.infer<typeof createInstanceInput>

export const instanceIdInput = z.object({ instanceId: z.string().min(1) })
export type InstanceIdInput = z.infer<typeof instanceIdInput>

export const instanceConfigInput = z.object({
	minecraftAccount: z.string().email(),
	serverAddress: z.string().min(1).max(253),
	autoRelogRetries: z.number().int().min(0).max(1000),
	autoRelogDelaySeconds: z.number().int().min(1).max(3600),
	antiAfkEnabled: z.boolean(),
	antiAfkIntervalSeconds: z.number().int().min(1).max(3600),
})
export type InstanceConfigInput = z.infer<typeof instanceConfigInput>

export const updateInstanceConfigInput = z.object({
	instanceId: z.string().min(1),
	config: instanceConfigInput,
})
export type UpdateInstanceConfigInput = z.infer<typeof updateInstanceConfigInput>

export const sendInstanceCommandInput = z.object({
	instanceId: z.string().min(1),
	command: z.string().min(1).max(256),
})
export type SendInstanceCommandInput = z.infer<typeof sendInstanceCommandInput>

export const readInstanceConsoleInput = z.object({
	instanceId: z.string().min(1),
	lines: z.number().int().min(1).max(1000).default(200),
})
export type ReadInstanceConsoleInput = z.infer<typeof readInstanceConsoleInput>

export const instancePublic = z.object({
	id: z.string(),
	hostId: z.string(),
	name: z.string(),
	minecraftAccount: z.string(),
	status: instanceStatusSchema,
	lastExitCode: z.number().int().nullable(),
	createdAt: z.date(),
})
export type InstancePublic = z.infer<typeof instancePublic>

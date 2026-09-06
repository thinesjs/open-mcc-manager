import { z } from "zod"

export const instanceStatusSchema = z.enum(["created", "needs_auth", "stopped", "running", "error"])
export type InstanceStatus = z.infer<typeof instanceStatusSchema>

export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const ACCOUNT_TYPES = ["microsoft", "offline"] as const

export const accountTypeSchema = z.enum(ACCOUNT_TYPES)

export type AccountType = z.infer<typeof accountTypeSchema>

export const MINECRAFT_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
	microsoft: "Microsoft",
	offline: "Offline",
}

export const minecraftNameOf = (instance: {
	accountType: AccountType
	minecraftAccount: string
	minecraftUsername: string | null
}): string | null => {
	if (instance.minecraftUsername !== null && instance.minecraftUsername.length > 0) {
		return instance.minecraftUsername
	}
	return instance.accountType === "offline" ? instance.minecraftAccount : null
}

export const isOfflineAccount = (accountType: AccountType): boolean => accountType === "offline"

export const needsInteractiveSignIn = (accountType: AccountType): boolean =>
	accountType === "microsoft"

export const accountIdentifier = (accountType: AccountType) =>
	isOfflineAccount(accountType)
		? z
				.string()
				.regex(
					MINECRAFT_USERNAME_PATTERN,
					"An offline account is a Minecraft username: 3 to 16 letters, digits or underscores",
				)
		: z.string().email("This login method signs in with an email address")

export const createInstanceInput = z
	.object({
		hostId: z.string().min(1),
		name: z.string().min(1).max(64),
		accountType: accountTypeSchema.default("microsoft"),
		minecraftAccount: z.string().min(1).max(255),
		serverAddress: z.string().min(1).max(253),
	})
	.superRefine((value, ctx) => {
		const result = accountIdentifier(value.accountType).safeParse(value.minecraftAccount)
		if (result.success) return
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["minecraftAccount"],
			message: result.error.issues[0]?.message ?? "Invalid account",
		})
	})
export type CreateInstanceInput = z.infer<typeof createInstanceInput>

export const instanceIdInput = z.object({ instanceId: z.string().min(1) })
export type InstanceIdInput = z.infer<typeof instanceIdInput>

export const instanceConfigInput = z
	.object({
		accountType: accountTypeSchema,
		minecraftAccount: z.string().min(1).max(255),
		serverAddress: z.string().min(1).max(253),
		autoRelogRetries: z.number().int().min(0).max(1000),
		autoRelogDelaySeconds: z.number().int().min(1).max(3600),
		antiAfkEnabled: z.boolean(),
		antiAfkIntervalSeconds: z.number().int().min(1).max(3600),
		autoRespawnEnabled: z.boolean().default(false),
		liveControlEnabled: z.boolean().default(false),
		liveControlPort: z.number().int().min(1024).max(65535).default(33333),
		worldDataEnabled: z.boolean().default(false),
		inventoryDataEnabled: z.boolean().default(false),
		entityDataEnabled: z.boolean().default(false),
	})
	.strict()
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
	accountType: accountTypeSchema,
	minecraftAccount: z.string(),
	status: instanceStatusSchema,
	lastExitCode: z.number().int().nullable(),
	createdAt: z.date(),
})
export type InstancePublic = z.infer<typeof instancePublic>

export const deviceCodeChallenge = z.object({
	userCode: z.string(),
	verificationUri: z.string(),
	expiresAt: z.date(),
})
export type DeviceCodeChallenge = z.infer<typeof deviceCodeChallenge>

export const authenticationState = z.object({
	authenticated: z.boolean(),
	status: instanceStatusSchema,
})
export type AuthenticationState = z.infer<typeof authenticationState>

export const observedStateSchema = z.enum([
	"active",
	"stuck",
	"inactive",
	"failed",
	"activating",
	"unknown",
])
export type ObservedState = z.infer<typeof observedStateSchema>

export const unitDriftSchema = z.object({
	kind: z.enum(["missing", "differs", "unexpected"]),
	unit: z.string(),
})
export type UnitDrift = z.infer<typeof unitDriftSchema>

export const stateDriftSchema = z.object({
	instanceId: z.string(),
	desired: instanceStatusSchema,
	observed: observedStateSchema,
})
export type StateDrift = z.infer<typeof stateDriftSchema>

export const configDriftSchema = z.object({
	instanceId: z.string(),
	kind: z.enum(["managed", "fixed", "section", "unreadable", "unreachable"]),
	key: z.string(),
	expected: z.string().nullable(),
	actual: z.string().nullable(),
})
export type ConfigDriftPublic = z.infer<typeof configDriftSchema>

export const hostReconciliationSchema = z.union([
	z.object({ hostId: z.string(), reachable: z.literal(false), reason: z.string() }),
	z.object({
		hostId: z.string(),
		reachable: z.literal(true),
		unitDrift: z.array(unitDriftSchema),
		stateDrift: z.array(stateDriftSchema),
		configDrift: z.array(configDriftSchema),
	}),
])
export type HostReconciliation = z.infer<typeof hostReconciliationSchema>

export const managerMetricsSchema = z.object({
	rssBytes: z.number(),
	heapUsedBytes: z.number(),
	heapTotalBytes: z.number(),
	externalBytes: z.number(),
	arrayBuffersBytes: z.number(),
	uptimeSeconds: z.number(),
	sampledAt: z.date(),
})
export type ManagerMetrics = z.infer<typeof managerMetricsSchema>

export const hostMetricsSchema = z.object({
	loadAverage1m: z.number(),
	memoryUsedMb: z.number(),
	memoryTotalMb: z.number(),
	diskUsedMb: z.number(),
	diskTotalMb: z.number(),
	uptimeSeconds: z.number(),
})
export type HostMetrics = z.infer<typeof hostMetricsSchema>

export const MAX_DROP_COUNT = 2304

export const dropInventoryItemInput = z.object({
	instanceId: z.string().min(1),
	itemType: z.string().min(1).max(64),
	count: z.number().int().min(1).max(MAX_DROP_COUNT),
})

export const selectHeldItemInput = z.object({
	instanceId: z.string().min(1),
	itemType: z.string().min(1).max(64),
})

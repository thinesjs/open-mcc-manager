import { z } from "zod"
import {
	advancedKeysSchema,
	botConfigSchema,
	storedBotConfigSchema,
} from "./boundary/mcc-config-keys"

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

export const AUTH_LEASE_MS = 15 * 60 * 1000

export const AUTH_LEASE_MINUTES = AUTH_LEASE_MS / 60_000

export const accountIdentifier = (accountType: AccountType) =>
	isOfflineAccount(accountType)
		? z
				.string()
				.regex(
					MINECRAFT_USERNAME_PATTERN,
					"An offline account is a Minecraft username: 3 to 16 letters, digits or underscores",
				)
		: z.string().email("This login method signs in with an email address")

const NO_PATH_IN_IT = "Cannot contain a slash, a backslash or .."

const withoutPathParts = (value: string): boolean =>
	!value.includes("/") &&
	!value.includes("\\") &&
	!value.includes("..") &&
	[...value].every((character) => (character.codePointAt(0) ?? 0) >= 0x20)

export const createInstanceInput = z
	.object({
		hostId: z.string().min(1),
		name: z.string().min(1).max(64),
		accountType: accountTypeSchema.default("microsoft"),
		minecraftAccount: z.string().min(1).max(255),
		serverAddress: z.string().min(1).max(253).refine(withoutPathParts, NO_PATH_IN_IT),
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

export const DELAY_SECONDS_MINIMUM = 1

export const DELAY_SECONDS_MAXIMUM = 3600

const delayBound = z.number().int().min(DELAY_SECONDS_MINIMUM).max(DELAY_SECONDS_MAXIMUM)

export const delaySecondsRange = z
	.object({ min: delayBound, max: delayBound })
	.strict()
	.refine((value) => value.min <= value.max, {
		message: "The shortest delay must not exceed the longest",
	})
export type DelaySecondsRange = z.infer<typeof delaySecondsRange>

export const instanceConfigInput = z
	.object({
		accountType: accountTypeSchema,
		minecraftAccount: z.string().min(1).max(255).refine(withoutPathParts, NO_PATH_IN_IT),
		serverAddress: z.string().min(1).max(253).refine(withoutPathParts, NO_PATH_IN_IT),
		autoRelogRetries: z.number().int().min(0).max(1000),
		autoRelogEnabled: z.boolean(),
		autoRelogDelaySeconds: delaySecondsRange,
		antiAfkEnabled: z.boolean(),
		antiAfkIntervalSeconds: delaySecondsRange,
		autoRespawnEnabled: z.boolean().default(false),
		liveControlEnabled: z.boolean().default(false),
		liveControlPort: z.number().int().min(1024).max(65535).default(33333),
		worldDataEnabled: z.boolean().default(false),
		inventoryDataEnabled: z.boolean().default(false),
		entityDataEnabled: z.boolean().default(false),
		advancedKeys: advancedKeysSchema.default({}),
		botConfig: botConfigSchema.default({}),
	})
	.strict()
export type InstanceConfigInput = z.infer<typeof instanceConfigInput>

const storedDelaySeconds = z.union([
	delayBound.transform((value) => ({ min: value, max: value })),
	delaySecondsRange,
])

export const instanceConfigStored = instanceConfigInput.extend({
	minecraftAccount: z.string().min(1).max(255),
	serverAddress: z.string().min(1).max(253),
	autoRelogEnabled: z.boolean().default(true),
	autoRelogDelaySeconds: storedDelaySeconds,
	antiAfkIntervalSeconds: storedDelaySeconds,
	botConfig: storedBotConfigSchema.default({}),
})

export type InstanceConfigStored = z.infer<typeof instanceConfigStored>

export const instanceConfigView = z.object({
	config: instanceConfigStored,
	version: z.number().int().min(1),
})
export type InstanceConfigView = z.infer<typeof instanceConfigView>

export const instanceSettingsInput = instanceConfigInput.omit({
	botConfig: true,
	advancedKeys: true,
})
export type InstanceSettingsInput = z.infer<typeof instanceSettingsInput>

export const updateInstanceConfigInput = z.object({
	instanceId: z.string().min(1),
	config: instanceSettingsInput,
	expectedVersion: z.number().int().min(1),
})
export type UpdateInstanceConfigInput = z.infer<typeof updateInstanceConfigInput>

export const instanceBotsInput = z
	.object({ botConfig: botConfigSchema, advancedKeys: advancedKeysSchema })
	.strict()
export type InstanceBotsInput = z.infer<typeof instanceBotsInput>

export const updateBotConfigInput = instanceBotsInput.extend({
	instanceId: z.string().min(1),
	expectedVersion: z.number().int().min(1),
})
export type UpdateBotConfigInput = z.infer<typeof updateBotConfigInput>

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
	minecraftUsername: z.string().nullable(),
	status: instanceStatusSchema,
	lastExitCode: z.number().int().nullable(),
	createdAt: z.string().datetime(),
})
export type InstancePublic = z.infer<typeof instancePublic>

export const deviceCodeChallenge = z.object({
	userCode: z.string(),
	verificationUri: z.string(),
	expiresAt: z.string().datetime(),
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

export const configDriftSchema = z.discriminatedUnion("kind", [
	z.object({
		instanceId: z.string(),
		kind: z.enum(["managed", "fixed", "section", "unreadable", "unreachable"]),
		key: z.string(),
		expected: z.string().nullable(),
		actual: z.string().nullable(),
	}),
	z.object({
		instanceId: z.string(),
		kind: z.literal("operator"),
		key: z.string(),
		expected: z.string(),
		actual: z.null(),
	}),
])
export type ConfigDriftPublic = z.infer<typeof configDriftSchema>

export const runtimeDriftSchema = z.object({
	kind: z.literal("network-stack"),
})
export type RuntimeDrift = z.infer<typeof runtimeDriftSchema>

export const hostUnreachableReasonSchema = z.enum([
	"misconfigured",
	"unprovisioned",
	"unreachable",
	"interrupted",
	"failed",
])
export type HostUnreachableReason = z.infer<typeof hostUnreachableReasonSchema>

export const hostReconciliationSchema = z.union([
	z.object({
		hostId: z.string(),
		reachable: z.literal(false),
		reason: hostUnreachableReasonSchema,
	}),
	z.object({
		hostId: z.string(),
		reachable: z.literal(true),
		runtimeDrift: z.array(runtimeDriftSchema),
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
	sampledAt: z.string().datetime(),
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

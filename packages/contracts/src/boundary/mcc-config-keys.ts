import { z } from "zod"

const INT32 = { min: -2147483648, max: 2147483647 } as const

const INTEGER_SHAPE = /^(0|-?[1-9][0-9]{0,9})$/
const FLOAT_SHAPE = /^-?(0|[1-9][0-9]*)\.[0-9]+$/

const CHOOSE_A_VALUE = { errorMap: () => ({ message: "Choose a value" }) }

const advancedBooleanSchema = z.string().regex(/^(true|false)$/, "Must be true or false")

const floatIssue = (value: string): string | undefined =>
	FLOAT_SHAPE.test(value) && Number.isFinite(Number(value)) ? undefined : "Decimal number"

const advancedFloatSchema = z.string().superRefine((value, ctx) => {
	const issue = floatIssue(value)
	if (issue !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue })
})

const integerWithin = (min: number, max: number) =>
	z
		.string()
		.regex(INTEGER_SHAPE, "Whole number, no leading zeroes")
		.refine(
			(value) => !INTEGER_SHAPE.test(value) || (Number(value) >= min && Number(value) <= max),
			{
				message: `Between ${min} and ${max}`,
			},
		)

const floatWhere = (accepts: (value: number) => boolean, message: string) =>
	z.string().superRefine((value, ctx) => {
		const issue = floatIssue(value) ?? (accepts(Number(value)) ? undefined : message)
		if (issue !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue })
	})

const PATH_SHAPE = /^[^/\\%]+$/
const EXPANDED_PATH_SHAPE = /^[^/\\]+$/

const isPlainText = (value: string): boolean => {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0
		if (code < 0x20 || code === 0x7f) return false
	}
	return true
}

const A_FILE_NAME = "A file name, not a path"

export const RESERVED_FILE_NAMES: readonly string[] = [
	"env",
	"control",
	"auth.log",
	"MinecraftClient.ini",
	"MinecraftClient.backup.ini",
	"SessionCache.db",
	"SessionCache.ini",
	"ProfileKeyCache.ini",
	"replay_recordings",
	"recording_cache",
	"Rendered_Maps",
	"lang",
]

export const DRAIN_TEMPORARY = "player-list.collecting"

export const isReservedFileName = (value: string): boolean =>
	RESERVED_FILE_NAMES.includes(value) || value === DRAIN_TEMPORARY

const NOT_RESERVED = { message: "The client already uses that file name" }

const FILE_NAME_MAX_BYTES = 255

const utf8Bytes = (value: string): number => {
	let bytes = 0
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0
		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
	}
	return bytes
}

const fileNameIssue = (value: string): string | undefined => {
	if (!PATH_SHAPE.test(value) || value === "." || value === ".." || !isPlainText(value)) {
		return A_FILE_NAME
	}
	return utf8Bytes(value) > FILE_NAME_MAX_BYTES ? "Too long for a file name" : undefined
}

export const isOperatorFileName = (value: string): boolean =>
	fileNameIssue(value) === undefined && !isReservedFileName(value)

const fileNameSchema = z
	.string()
	.min(1)
	.superRefine((value, ctx) => {
		const issue = fileNameIssue(value)
		if (issue !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue })
	})

const expandedFileNameSchema = z
	.string()
	.min(1)
	.regex(EXPANDED_PATH_SHAPE, A_FILE_NAME)
	.refine((value) => value !== "." && value !== ".." && isPlainText(value), {
		message: A_FILE_NAME,
	})

const pathSchema = fileNameSchema.refine((value) => !isReservedFileName(value), NOT_RESERVED)

const alertWordsSchema = z.array(
	z.string().min(1).refine(isPlainText, { message: "One line per entry" }),
)

export const ADVANCED_ENUM_SHAPE = {
	"ChatBot.AutoAttack.Mode": z.enum(["single", "multi"], CHOOSE_A_VALUE),
	"ChatBot.AutoAttack.Priority": z.enum(["distance", "health"], CHOOSE_A_VALUE),
	"ChatBot.AutoAttack.Interaction": z.enum(["Interact", "Attack", "InteractAt"], CHOOSE_A_VALUE),
	"ChatBot.AutoAttack.List_Mode": z.enum(["blacklist", "whitelist"], CHOOSE_A_VALUE),
	"ChatBot.AutoCraft.OnFailure": z.enum(["abort", "wait"], CHOOSE_A_VALUE),
	"ChatBot.AutoDig.Mode": z.enum(["lookat", "fixedpos", "both"], CHOOSE_A_VALUE),
	"ChatBot.AutoDig.Location_Order": z.enum(["distance", "index"], CHOOSE_A_VALUE),
	"ChatBot.AutoDig.List_Type": z.enum(["blacklist", "whitelist"], CHOOSE_A_VALUE),
	"ChatBot.AutoDrop.Mode": z.enum(["include", "exclude", "everything"], CHOOSE_A_VALUE),
}

export const ADVANCED_BOOLEAN_SHAPE = {
	"ChatBot.AutoAttack.Enabled": advancedBooleanSchema,
	"ChatBot.AutoAttack.Cooldown_Time.Custom": advancedBooleanSchema,
	"ChatBot.AutoAttack.Cooldown_Time.RandomMode": advancedBooleanSchema,
	"ChatBot.AutoAttack.Attack_Hostile": advancedBooleanSchema,
	"ChatBot.AutoAttack.Attack_Passive": advancedBooleanSchema,
	"ChatBot.AutoCraft.Enabled": advancedBooleanSchema,
	"ChatBot.AutoDig.Enabled": advancedBooleanSchema,
	"ChatBot.AutoDig.Auto_Tool_Switch": advancedBooleanSchema,
	"ChatBot.AutoDig.Apply_Efficiency_Enchantments": advancedBooleanSchema,
	"ChatBot.AutoDig.Apply_Haste_Effects": advancedBooleanSchema,
	"ChatBot.AutoDig.Drop_Low_Durability_Tools": advancedBooleanSchema,
	"ChatBot.AutoDig.Log_Block_Dig": advancedBooleanSchema,
	"ChatBot.AutoDrop.Enabled": advancedBooleanSchema,
	"ChatBot.AutoEat.Enabled": advancedBooleanSchema,
	"ChatBot.AutoFishing.Enabled": advancedBooleanSchema,
	"ChatBot.AutoFishing.Antidespawn": advancedBooleanSchema,
	"ChatBot.AutoFishing.Mainhand": advancedBooleanSchema,
	"ChatBot.AutoFishing.Auto_Start": advancedBooleanSchema,
	"ChatBot.AutoFishing.Auto_Rod_Switch": advancedBooleanSchema,
	"ChatBot.AutoFishing.Enable_Velocity_Detection": advancedBooleanSchema,
	"ChatBot.AutoFishing.Enable_Sound_Detection": advancedBooleanSchema,
	"ChatBot.AutoFishing.Log_Fish_Bobber": advancedBooleanSchema,
	"ChatBot.AutoFishing.Enable_Move": advancedBooleanSchema,
	"ChatBot.Farmer.Enabled": advancedBooleanSchema,
	"ChatBot.ItemsCollector.Enabled": advancedBooleanSchema,
	"ChatBot.ItemsCollector.Collect_All_Item_Types": advancedBooleanSchema,
	"ChatBot.ItemsCollector.Always_Return_To_Start": advancedBooleanSchema,
	"ChatBot.ItemsCollector.Prioritize_Clusters": advancedBooleanSchema,
}

export const ADVANCED_NUMBER_SHAPE = {
	"ChatBot.AutoAttack.Cooldown_Time.Min": advancedFloatSchema,
	"ChatBot.AutoAttack.Cooldown_Time.Max": advancedFloatSchema,
	"ChatBot.AutoAttack.Attack_Range": floatWhere(
		(value) => value >= 1 && value <= 4,
		"Between 1 and 4",
	),
	"ChatBot.AutoCraft.CraftingTable.X": advancedFloatSchema,
	"ChatBot.AutoCraft.CraftingTable.Y": advancedFloatSchema,
	"ChatBot.AutoCraft.CraftingTable.Z": advancedFloatSchema,
	"ChatBot.AutoDig.Durability_Limit": integerWithin(0, INT32.max),
	"ChatBot.AutoDig.Auto_Start_Delay": floatWhere(
		(value) => value < 0 || value >= 0.1,
		"0.1 or more, or negative",
	),
	"ChatBot.AutoDig.Dig_Timeout": floatWhere(
		(value) => value < 0 || value >= 0.1,
		"0.1 or more, or negative",
	),
	"ChatBot.AutoEat.Threshold": integerWithin(0, 20),
	"ChatBot.AutoFishing.Cast_Delay": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.AutoFishing.Fishing_Delay": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.AutoFishing.Fishing_Timeout": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.AutoFishing.Durability_Limit": floatWhere(
		(value) => value >= 0 && value <= 64,
		"Between 0 and 64",
	),
	"ChatBot.AutoFishing.Stationary_Threshold": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.AutoFishing.Hook_Threshold": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.AutoFishing.Velocity_Hook_Threshold": floatWhere((value) => value <= 0, "0 or less"),
	"ChatBot.AutoFishing.Sound_Distance": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.AutoFishing.Detection_Warmup": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.Farmer.Delay_Between_Tasks": floatWhere((value) => value >= 1, "1 or more"),
	"ChatBot.ItemsCollector.Delay_Between_Tasks": integerWithin(100, INT32.max),
	"ChatBot.ItemsCollector.Collection_Radius": advancedFloatSchema,
}

export const ADVANCED_LITERAL_SHAPE = {
	...ADVANCED_BOOLEAN_SHAPE,
	...ADVANCED_NUMBER_SHAPE,
}

export const ADVANCED_KEY_SHAPE = { ...ADVANCED_ENUM_SHAPE, ...ADVANCED_LITERAL_SHAPE }

export const advancedKeysSchema = z.object(ADVANCED_KEY_SHAPE).partial().strict()
export type AdvancedKeys = z.infer<typeof advancedKeysSchema>
export type AdvancedKeyName = keyof AdvancedKeys

export const ADVANCED_KEY_NAMES: readonly string[] = z
	.object(ADVANCED_KEY_SHAPE)
	.keyof()
	.options.slice()
	.sort((left, right) => left.localeCompare(right))
export const ADVANCED_ENUM_NAMES: readonly string[] = z.object(ADVANCED_ENUM_SHAPE).keyof().options

export const ADVANCED_BOOLEAN_NAMES: readonly string[] = z
	.object(ADVANCED_BOOLEAN_SHAPE)
	.keyof().options

export const BOT_CONFIG_PATH_SHAPE = {
	"ChatBot.Mailer.DatabaseFile": pathSchema,
	"ChatBot.Mailer.IgnoreListFile": pathSchema,
	"ChatBot.PlayerListLogger.File": pathSchema,
}

export const BOT_CONFIG_ENUM_SHAPE = {}

export const BOT_CONFIG_QUOTED_SHAPE = { ...BOT_CONFIG_PATH_SHAPE, ...BOT_CONFIG_ENUM_SHAPE }

export const BOT_CONFIG_LIST_SHAPE = {
	"ChatBot.Alerts.Matches": alertWordsSchema,
	"ChatBot.Alerts.Excludes": alertWordsSchema,
}

export const BOT_CONFIG_BOOLEAN_SHAPE = {
	"ChatBot.Alerts.Enabled": advancedBooleanSchema,
	"ChatBot.Alerts.Beep_Enabled": advancedBooleanSchema,
	"ChatBot.Alerts.Trigger_By_Words": advancedBooleanSchema,
	"ChatBot.Alerts.Trigger_By_Rain": advancedBooleanSchema,
	"ChatBot.Alerts.Trigger_By_Thunderstorm": advancedBooleanSchema,
	"ChatBot.Map.Enabled": advancedBooleanSchema,
	"ChatBot.Map.Render_In_Console": advancedBooleanSchema,
	"ChatBot.Map.Auto_Render_On_Update": advancedBooleanSchema,
	"ChatBot.Map.Delete_All_On_Unload": advancedBooleanSchema,
	"ChatBot.Map.Notify_On_First_Update": advancedBooleanSchema,
	"ChatBot.Mailer.Enabled": advancedBooleanSchema,
	"ChatBot.Mailer.PublicInteractions": advancedBooleanSchema,
	"ChatBot.PlayerListLogger.Enabled": advancedBooleanSchema,
	"ChatBot.FollowPlayer.Enabled": advancedBooleanSchema,
	"ChatBot.RemoteControl.Enabled": advancedBooleanSchema,
	"ChatBot.RemoteControl.AutoTpaccept": advancedBooleanSchema,
	"ChatBot.RemoteControl.AutoTpaccept_Everyone": advancedBooleanSchema,
	"ChatBot.ReplayCapture.Enabled": advancedBooleanSchema,
}

export const BOT_CONFIG_INTEGER_SHAPE = {
	"ChatBot.Mailer.MaxMailsPerPlayer": integerWithin(1, INT32.max),
	"ChatBot.Mailer.MaxDatabaseSize": integerWithin(1, INT32.max),
	"ChatBot.Mailer.MailRetentionDays": integerWithin(1, INT32.max),
}

export const BOT_CONFIG_FLOAT_SHAPE = {
	"ChatBot.PlayerListLogger.Delay": floatWhere((value) => value >= 1, "1 or more"),
	"ChatBot.FollowPlayer.Update_Limit": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.FollowPlayer.Stop_At_Distance": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.ReplayCapture.Backup_Interval": floatWhere((value) => value >= -1, "-1 or more"),
}

export const BOT_CONFIG_BARE_SHAPE = {
	...BOT_CONFIG_BOOLEAN_SHAPE,
	...BOT_CONFIG_INTEGER_SHAPE,
	...BOT_CONFIG_FLOAT_SHAPE,
}

export const BOT_CONFIG_SHAPE = {
	...BOT_CONFIG_QUOTED_SHAPE,
	...BOT_CONFIG_LIST_SHAPE,
	...BOT_CONFIG_BARE_SHAPE,
}

export const CLIENT_DEFAULT_FILES: Readonly<Record<keyof typeof BOT_CONFIG_PATH_SHAPE, string>> = {
	"ChatBot.Mailer.DatabaseFile": "MailerDatabase.ini",
	"ChatBot.Mailer.IgnoreListFile": "MailerIgnoreList.ini",
	"ChatBot.PlayerListLogger.File": "playerlog.txt",
}

const sharedFileKeys = (config: Readonly<Record<string, unknown>>): readonly string[] => {
	const files = Object.entries(CLIENT_DEFAULT_FILES).map(([key, fallback]) => ({
		key,
		set: config[key] !== undefined,
		file: config[key] ?? fallback,
	}))
	return files
		.filter(
			(each) =>
				each.set && files.some((other) => other.key !== each.key && other.file === each.file),
		)
		.map((each) => each.key)
}

export const botConfigSchema = z
	.object(BOT_CONFIG_SHAPE)
	.partial()
	.strict()
	.superRefine((config, ctx) => {
		for (const key of sharedFileKeys(config)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: [key],
				message: "Another setting already uses that file name",
			})
		}
	})
export type BotConfig = z.infer<typeof botConfigSchema>

export const storedBotConfigSchema = z
	.object({
		...BOT_CONFIG_SHAPE,
		"ChatBot.Mailer.DatabaseFile": fileNameSchema,
		"ChatBot.Mailer.IgnoreListFile": fileNameSchema,
		"ChatBot.PlayerListLogger.File": expandedFileNameSchema,
	})
	.partial()
	.strict()
export type BotConfigName = keyof BotConfig

export const BOT_CONFIG_NAMES: readonly string[] = z.object(BOT_CONFIG_SHAPE).keyof().options

export const SETTING_SHAPE = { ...BOT_CONFIG_SHAPE, ...ADVANCED_KEY_SHAPE }

export const SETTING_ENUM_SHAPE = { ...BOT_CONFIG_ENUM_SHAPE, ...ADVANCED_ENUM_SHAPE }

export const SETTING_BOOLEAN_SHAPE = { ...BOT_CONFIG_BOOLEAN_SHAPE, ...ADVANCED_BOOLEAN_SHAPE }

export type SettingName = BotConfigName | AdvancedKeyName

export const SETTING_BOOLEAN_NAMES: readonly string[] = z
	.object(SETTING_BOOLEAN_SHAPE)
	.keyof().options

export const SETTING_NAMES: readonly SettingName[] = z
	.object(SETTING_SHAPE)
	.keyof()
	.options.slice()
	.sort((left, right) => left.localeCompare(right))

export const BOT_CONFIG_BOOLEAN_NAMES: readonly string[] = z
	.object(BOT_CONFIG_BOOLEAN_SHAPE)
	.keyof().options

export const QUOTED_CONFIG_NAMES: readonly string[] = [
	...z.object(ADVANCED_ENUM_SHAPE).keyof().options,
	...z.object(BOT_CONFIG_QUOTED_SHAPE).keyof().options,
]

export const LIST_CONFIG_NAMES: readonly string[] = z.object(BOT_CONFIG_LIST_SHAPE).keyof().options

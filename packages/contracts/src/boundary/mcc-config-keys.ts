import { z } from "zod"

const INT32 = { min: -2147483648, max: 2147483647 } as const

const INTEGER_SHAPE = /^(0|-?[1-9][0-9]{0,9})$/
const FLOAT_SHAPE = /^-?(0|[1-9][0-9]{0,15})\.[0-9]{1,6}$/

const CHOOSE_A_VALUE = { errorMap: () => ({ message: "Choose a value" }) }

const advancedBooleanSchema = z.string().regex(/^(true|false)$/, "Must be true or false")

const advancedFloatSchema = z.string().regex(FLOAT_SHAPE, "Decimal number")

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
	advancedFloatSchema.refine((value) => !FLOAT_SHAPE.test(value) || accepts(Number(value)), {
		message,
	})

const PATH_SHAPE = /^[^/\\%]+$/
const CHAT_LOG_PATH_SHAPE = /^[^/\\]+$/
const CHAT_LOG_TOKENS = /%username%|%serverip%/g

const isPlainText = (value: string): boolean => {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0
		if (code < 0x20 || code === 0x7f) return false
	}
	return true
}

const A_FILE_NAME = "A file name, not a path"

const pathSchema = z
	.string()
	.min(1)
	.regex(PATH_SHAPE, A_FILE_NAME)
	.refine((value) => value !== "." && value !== ".." && isPlainText(value), {
		message: A_FILE_NAME,
	})

const chatLogPathSchema = z
	.string()
	.min(1)
	.regex(CHAT_LOG_PATH_SHAPE, A_FILE_NAME)
	.refine((value) => value !== "." && value !== ".." && isPlainText(value), {
		message: A_FILE_NAME,
	})
	.refine((value) => !value.replace(CHAT_LOG_TOKENS, "").includes("%"), {
		message: "Only %username% and %serverip% can be used here",
	})

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

export const ADVANCED_LITERAL_SHAPE = {
	"ChatBot.AutoAttack.Enabled": advancedBooleanSchema,
	"ChatBot.AutoAttack.Cooldown_Time.Custom": advancedBooleanSchema,
	"ChatBot.AutoAttack.Cooldown_Time.RandomMode": advancedBooleanSchema,
	"ChatBot.AutoAttack.Cooldown_Time.Min": advancedFloatSchema,
	"ChatBot.AutoAttack.Cooldown_Time.Max": advancedFloatSchema,
	"ChatBot.AutoAttack.Attack_Range": floatWhere(
		(value) => value >= 1 && value <= 4,
		"Between 1 and 4",
	),
	"ChatBot.AutoAttack.Attack_Hostile": advancedBooleanSchema,
	"ChatBot.AutoAttack.Attack_Passive": advancedBooleanSchema,
	"ChatBot.AutoCraft.Enabled": advancedBooleanSchema,
	"ChatBot.AutoCraft.CraftingTable.X": advancedFloatSchema,
	"ChatBot.AutoCraft.CraftingTable.Y": advancedFloatSchema,
	"ChatBot.AutoCraft.CraftingTable.Z": advancedFloatSchema,
	"ChatBot.AutoDig.Enabled": advancedBooleanSchema,
	"ChatBot.AutoDig.Auto_Tool_Switch": advancedBooleanSchema,
	"ChatBot.AutoDig.Apply_Efficiency_Enchantments": advancedBooleanSchema,
	"ChatBot.AutoDig.Apply_Haste_Effects": advancedBooleanSchema,
	"ChatBot.AutoDig.Durability_Limit": integerWithin(0, INT32.max),
	"ChatBot.AutoDig.Drop_Low_Durability_Tools": advancedBooleanSchema,
	"ChatBot.AutoDig.Auto_Start_Delay": floatWhere(
		(value) => value < 0 || value >= 0.1,
		"0.1 or more, or negative",
	),
	"ChatBot.AutoDig.Dig_Timeout": floatWhere(
		(value) => value < 0 || value >= 0.1,
		"0.1 or more, or negative",
	),
	"ChatBot.AutoDig.Log_Block_Dig": advancedBooleanSchema,
	"ChatBot.AutoDrop.Enabled": advancedBooleanSchema,
	"ChatBot.AutoEat.Enabled": advancedBooleanSchema,
	"ChatBot.AutoEat.Threshold": integerWithin(0, 20),
	"ChatBot.AutoFishing.Enabled": advancedBooleanSchema,
	"ChatBot.AutoFishing.Antidespawn": advancedBooleanSchema,
	"ChatBot.AutoFishing.Mainhand": advancedBooleanSchema,
	"ChatBot.AutoFishing.Auto_Start": advancedBooleanSchema,
	"ChatBot.AutoFishing.Cast_Delay": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.AutoFishing.Fishing_Delay": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.AutoFishing.Fishing_Timeout": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.AutoFishing.Durability_Limit": floatWhere(
		(value) => value >= 0 && value <= 64,
		"Between 0 and 64",
	),
	"ChatBot.AutoFishing.Auto_Rod_Switch": advancedBooleanSchema,
	"ChatBot.AutoFishing.Stationary_Threshold": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.AutoFishing.Hook_Threshold": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.AutoFishing.Enable_Velocity_Detection": advancedBooleanSchema,
	"ChatBot.AutoFishing.Velocity_Hook_Threshold": floatWhere((value) => value <= 0, "0 or less"),
	"ChatBot.AutoFishing.Enable_Sound_Detection": advancedBooleanSchema,
	"ChatBot.AutoFishing.Sound_Distance": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.AutoFishing.Detection_Warmup": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.AutoFishing.Log_Fish_Bobber": advancedBooleanSchema,
	"ChatBot.AutoFishing.Enable_Move": advancedBooleanSchema,
	"ChatBot.Farmer.Enabled": advancedBooleanSchema,
	"ChatBot.Farmer.Delay_Between_Tasks": floatWhere((value) => value >= 1, "1 or more"),
	"ChatBot.ItemsCollector.Enabled": advancedBooleanSchema,
	"ChatBot.ItemsCollector.Collect_All_Item_Types": advancedBooleanSchema,
	"ChatBot.ItemsCollector.Delay_Between_Tasks": integerWithin(100, INT32.max),
	"ChatBot.ItemsCollector.Collection_Radius": advancedFloatSchema,
	"ChatBot.ItemsCollector.Always_Return_To_Start": advancedBooleanSchema,
	"ChatBot.ItemsCollector.Prioritize_Clusters": advancedBooleanSchema,
}

export const ADVANCED_KEY_SHAPE = { ...ADVANCED_ENUM_SHAPE, ...ADVANCED_LITERAL_SHAPE }

export const advancedKeysSchema = z.object(ADVANCED_KEY_SHAPE).partial().strict()
export type AdvancedKeys = z.infer<typeof advancedKeysSchema>
export type AdvancedKeyName = keyof AdvancedKeys

export const ADVANCED_KEY_NAMES: readonly string[] = z.object(ADVANCED_KEY_SHAPE).keyof().options
export const ADVANCED_ENUM_NAMES: readonly string[] = z.object(ADVANCED_ENUM_SHAPE).keyof().options

export const advancedKeyRowSchema = z.object({
	key: z.object(ADVANCED_KEY_SHAPE).keyof().nullable(),
	value: z.string(),
})
export type AdvancedKeyRow = z.infer<typeof advancedKeyRowSchema>

export const BOT_CONFIG_QUOTED_SHAPE = {
	"ChatBot.Alerts.Log_File": pathSchema,
	"ChatBot.Mailer.DatabaseFile": pathSchema,
	"ChatBot.Mailer.IgnoreListFile": pathSchema,
	"ChatBot.PlayerListLogger.File": pathSchema,
	"ChatBot.ChatLog.Log_File": chatLogPathSchema,
	"ChatBot.ChatLog.Filter": z.enum(
		["all", "messages", "chat", "private_chat", "internal_msg"],
		CHOOSE_A_VALUE,
	),
}

export const BOT_CONFIG_LIST_SHAPE = {
	"ChatBot.Alerts.Matches": alertWordsSchema,
	"ChatBot.Alerts.Excludes": alertWordsSchema,
}

export const BOT_CONFIG_BARE_SHAPE = {
	"ChatBot.Alerts.Enabled": advancedBooleanSchema,
	"ChatBot.Alerts.Beep_Enabled": advancedBooleanSchema,
	"ChatBot.Alerts.Trigger_By_Words": advancedBooleanSchema,
	"ChatBot.Alerts.Trigger_By_Rain": advancedBooleanSchema,
	"ChatBot.Alerts.Trigger_By_Thunderstorm": advancedBooleanSchema,
	"ChatBot.Alerts.Log_To_File": advancedBooleanSchema,
	"ChatBot.Map.Enabled": advancedBooleanSchema,
	"ChatBot.Map.Render_In_Console": advancedBooleanSchema,
	"ChatBot.Map.Save_To_File": advancedBooleanSchema,
	"ChatBot.Map.Auto_Render_On_Update": advancedBooleanSchema,
	"ChatBot.Map.Delete_All_On_Unload": advancedBooleanSchema,
	"ChatBot.Map.Notify_On_First_Update": advancedBooleanSchema,
	"ChatBot.Map.Rasize_Rendered_Image": advancedBooleanSchema,
	"ChatBot.Map.Resize_To": integerWithin(1, INT32.max),
	"ChatBot.Mailer.Enabled": advancedBooleanSchema,
	"ChatBot.Mailer.PublicInteractions": advancedBooleanSchema,
	"ChatBot.Mailer.MaxMailsPerPlayer": integerWithin(1, INT32.max),
	"ChatBot.Mailer.MaxDatabaseSize": integerWithin(1, INT32.max),
	"ChatBot.Mailer.MailRetentionDays": integerWithin(1, INT32.max),
	"ChatBot.ChatLog.Enabled": advancedBooleanSchema,
	"ChatBot.ChatLog.Add_DateTime": advancedBooleanSchema,
	"ChatBot.PlayerListLogger.Enabled": advancedBooleanSchema,
	"ChatBot.PlayerListLogger.Delay": floatWhere((value) => value >= 1, "1 or more"),
	"ChatBot.FollowPlayer.Enabled": advancedBooleanSchema,
	"ChatBot.FollowPlayer.Update_Limit": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.FollowPlayer.Stop_At_Distance": floatWhere((value) => value >= 0, "0 or more"),
	"ChatBot.RemoteControl.Enabled": advancedBooleanSchema,
	"ChatBot.RemoteControl.AutoTpaccept": advancedBooleanSchema,
	"ChatBot.RemoteControl.AutoTpaccept_Everyone": advancedBooleanSchema,
	"ChatBot.ReplayCapture.Enabled": advancedBooleanSchema,
	"ChatBot.ReplayCapture.Backup_Interval": floatWhere((value) => value >= -1, "-1 or more"),
}

export const BOT_CONFIG_SHAPE = {
	...BOT_CONFIG_QUOTED_SHAPE,
	...BOT_CONFIG_LIST_SHAPE,
	...BOT_CONFIG_BARE_SHAPE,
}

export const botConfigSchema = z.object(BOT_CONFIG_SHAPE).partial().strict()
export type BotConfig = z.infer<typeof botConfigSchema>
export type BotConfigName = keyof BotConfig

export const BOT_CONFIG_NAMES: readonly string[] = z.object(BOT_CONFIG_SHAPE).keyof().options

export const QUOTED_CONFIG_NAMES: readonly string[] = [
	...z.object(ADVANCED_ENUM_SHAPE).keyof().options,
	...z.object(BOT_CONFIG_QUOTED_SHAPE).keyof().options,
]

export const LIST_CONFIG_NAMES: readonly string[] = z.object(BOT_CONFIG_LIST_SHAPE).keyof().options

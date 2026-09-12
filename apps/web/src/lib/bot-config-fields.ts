import type { InstanceConfigInput } from "@open-mcc/contracts"
import {
	type BOT_CONFIG_ENUM_SHAPE,
	BOT_CONFIG_LIST_SHAPE,
	BOT_CONFIG_SHAPE,
	type BotConfigName,
	type SettingName,
} from "@open-mcc/contracts/boundary/mcc-config-keys"
import { z } from "zod"

export type BotConfigField = {
	readonly label: string
	readonly description?: string
	readonly clientDefault: string | readonly string[]
}

export const BOT_CONFIG_FIELDS: Record<SettingName, BotConfigField> = {
	"ChatBot.AutoAttack.Attack_Hostile": { label: "Attack hostile creatures", clientDefault: "true" },
	"ChatBot.AutoAttack.Attack_Passive": {
		label: "Attack passive creatures",
		clientDefault: "false",
	},
	"ChatBot.AutoAttack.Attack_Range": { label: "How far to reach (blocks)", clientDefault: "4.0" },
	"ChatBot.AutoAttack.Cooldown_Time.Custom": {
		label: "Set the delay between swings yourself",
		clientDefault: "false",
	},
	"ChatBot.AutoAttack.Cooldown_Time.Max": {
		label: "Longest delay (seconds)",
		clientDefault: "2.5",
	},
	"ChatBot.AutoAttack.Cooldown_Time.Min": {
		label: "Shortest delay (seconds)",
		clientDefault: "1.5",
	},
	"ChatBot.AutoAttack.Cooldown_Time.RandomMode": {
		label: "Vary the delay between swings",
		clientDefault: "false",
	},
	"ChatBot.AutoAttack.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.AutoAttack.Interaction": { label: "What to do to it", clientDefault: "Attack" },
	"ChatBot.AutoAttack.List_Mode": {
		label: "Treat the creature list as",
		description:
			"The list cannot be edited here. When it is non-empty, whitelist mode overrides the hostile and passive choices.",
		clientDefault: "whitelist",
	},
	"ChatBot.AutoAttack.Mode": { label: "Targets per swing", clientDefault: "single" },
	"ChatBot.AutoAttack.Priority": { label: "Choose a target by", clientDefault: "distance" },
	"ChatBot.AutoCraft.CraftingTable.X": { label: "Crafting table X", clientDefault: "123.0" },
	"ChatBot.AutoCraft.CraftingTable.Y": { label: "Crafting table Y", clientDefault: "65.0" },
	"ChatBot.AutoCraft.CraftingTable.Z": { label: "Crafting table Z", clientDefault: "456.0" },
	"ChatBot.AutoCraft.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.AutoCraft.OnFailure": { label: "If a craft fails", clientDefault: "abort" },
	"ChatBot.AutoDig.Apply_Efficiency_Enchantments": {
		label: "Count tool enchantments when timing a dig",
		clientDefault: "true",
	},
	"ChatBot.AutoDig.Apply_Haste_Effects": {
		label: "Count speed effects when timing a dig",
		clientDefault: "true",
	},
	"ChatBot.AutoDig.Auto_Start_Delay": {
		label: "Auto-start delay (seconds)",
		description: "Use -1 to never start on its own.",
		clientDefault: "3.0",
	},
	"ChatBot.AutoDig.Auto_Tool_Switch": { label: "Switch to the right tool", clientDefault: "false" },
	"ChatBot.AutoDig.Dig_Timeout": {
		label: "Dig timeout (seconds)",
		description:
			"It then picks a target again, which may be the same block. A negative value times out on the next update.",
		clientDefault: "60.0",
	},
	"ChatBot.AutoDig.Drop_Low_Durability_Tools": {
		label: "Drop worn tools",
		clientDefault: "false",
	},
	"ChatBot.AutoDig.Durability_Limit": {
		label: "Lowest tool durability to use",
		description: "Zero turns the check off.",
		clientDefault: "2",
	},
	"ChatBot.AutoDig.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.AutoDig.List_Type": {
		label: "Treat the block list as",
		description: "The list itself is the client's own and cannot be edited here.",
		clientDefault: "whitelist",
	},
	"ChatBot.AutoDig.Location_Order": {
		label: "Order to work through positions",
		clientDefault: "distance",
	},
	"ChatBot.AutoDig.Log_Block_Dig": { label: "Log each block dug", clientDefault: "true" },
	"ChatBot.AutoDig.Mode": { label: "What to dig", clientDefault: "lookat" },
	"ChatBot.AutoDrop.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.AutoDrop.Mode": {
		label: "What to drop",
		description: "The item list is the client's own and cannot be edited here.",
		clientDefault: "include",
	},
	"ChatBot.AutoEat.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.AutoEat.Threshold": {
		label: "Eat when hunger drops to",
		description: "Out of 20. The client also eats whenever hunger and health are both below 20.",
		clientDefault: "6",
	},
	"ChatBot.AutoFishing.Antidespawn": {
		label: "Cast again if the bobber vanishes",
		clientDefault: "false",
	},
	"ChatBot.AutoFishing.Auto_Rod_Switch": {
		label: "Swap rods automatically",
		clientDefault: "true",
	},
	"ChatBot.AutoFishing.Auto_Start": {
		label: "Start fishing automatically",
		clientDefault: "true",
	},
	"ChatBot.AutoFishing.Cast_Delay": {
		label: "Delay between casts (seconds)",
		clientDefault: "0.4",
	},
	"ChatBot.AutoFishing.Detection_Warmup": {
		label: "Bite detection warm-up (seconds)",
		clientDefault: "1.0",
	},
	"ChatBot.AutoFishing.Durability_Limit": {
		label: "Lowest rod durability (of 64)",
		description: "Zero turns the check off. A full rod is 64.",
		clientDefault: "2.0",
	},
	"ChatBot.AutoFishing.Enable_Move": {
		label: "Move between spots",
		description: "The spots are the client's own and cannot be edited here.",
		clientDefault: "false",
	},
	"ChatBot.AutoFishing.Enable_Sound_Detection": {
		label: "Detect bites from the splash sound",
		clientDefault: "true",
	},
	"ChatBot.AutoFishing.Enable_Velocity_Detection": {
		label: "Detect bites from bobber movement",
		clientDefault: "true",
	},
	"ChatBot.AutoFishing.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.AutoFishing.Fishing_Delay": {
		label: "Delay before the first cast (seconds)",
		clientDefault: "3.0",
	},
	"ChatBot.AutoFishing.Fishing_Timeout": {
		label: "Cast timeout (seconds)",
		clientDefault: "300.0",
	},
	"ChatBot.AutoFishing.Hook_Threshold": {
		label: "Vertical movement that counts as a bite",
		clientDefault: "0.2",
	},
	"ChatBot.AutoFishing.Log_Fish_Bobber": {
		label: "Log the bobber's movement",
		clientDefault: "false",
	},
	"ChatBot.AutoFishing.Mainhand": { label: "Hold the rod in the main hand", clientDefault: "true" },
	"ChatBot.AutoFishing.Sound_Distance": {
		label: "Splash distance (blocks)",
		clientDefault: "5.0",
	},
	"ChatBot.AutoFishing.Stationary_Threshold": {
		label: "Sideways movement still counted as still",
		clientDefault: "0.001",
	},
	"ChatBot.AutoFishing.Velocity_Hook_Threshold": {
		label: "Falling speed that counts as a bite",
		clientDefault: "-0.2",
	},
	"ChatBot.Farmer.Delay_Between_Tasks": {
		label: "Delay between tasks (seconds)",
		clientDefault: "1.0",
	},
	"ChatBot.Farmer.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.ItemsCollector.Always_Return_To_Start": {
		label: "Return to the starting point",
		clientDefault: "true",
	},
	"ChatBot.ItemsCollector.Collect_All_Item_Types": {
		label: "Pick up everything",
		description: "Turn off to use the client's own item list instead.",
		clientDefault: "true",
	},
	"ChatBot.ItemsCollector.Collection_Radius": {
		label: "Search radius (blocks)",
		clientDefault: "30.0",
	},
	"ChatBot.ItemsCollector.Delay_Between_Tasks": {
		label: "Delay between sweeps (milliseconds)",
		clientDefault: "300",
	},
	"ChatBot.ItemsCollector.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.ItemsCollector.Prioritize_Clusters": {
		label: "Prefer clustered items",
		clientDefault: "false",
	},
	"ChatBot.Alerts.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.Alerts.Beep_Enabled": { label: "Beep on alert", clientDefault: "true" },
	"ChatBot.Alerts.Trigger_By_Words": { label: "Alert on matched words", clientDefault: "false" },
	"ChatBot.Alerts.Trigger_By_Rain": {
		label: "Alert when rain starts or stops",
		clientDefault: "false",
	},
	"ChatBot.Alerts.Trigger_By_Thunderstorm": {
		label: "Alert when a thunderstorm starts or ends",
		clientDefault: "false",
	},
	"ChatBot.Alerts.Matches": {
		label: "Words to alert on",
		clientDefault: ["Yourname", " whispers ", "-> me", "admin", ".com"],
	},
	"ChatBot.Alerts.Excludes": {
		label: "Words to ignore",
		clientDefault: [
			"myserver.com",
			"Yourname>:",
			"Player Yourname",
			"Yourname joined",
			"Yourname left",
			"[Lockette] (Admin)",
			" Yourname:",
			"Yourname is",
		],
	},
	"ChatBot.Map.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.Map.Render_In_Console": { label: "Draw maps in the console", clientDefault: "true" },
	"ChatBot.Map.Auto_Render_On_Update": {
		label: "Draw each map as it arrives",
		clientDefault: "false",
	},
	"ChatBot.Map.Delete_All_On_Unload": {
		label: "Delete saved maps on start and stop",
		clientDefault: "true",
	},
	"ChatBot.Map.Notify_On_First_Update": {
		label: "Notify on the first map received",
		clientDefault: "true",
	},
	"ChatBot.Mailer.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.Mailer.DatabaseFile": {
		label: "Mail database file",
		clientDefault: "MailerDatabase.ini",
	},
	"ChatBot.Mailer.IgnoreListFile": {
		label: "Ignore list file",
		clientDefault: "MailerIgnoreList.ini",
	},
	"ChatBot.Mailer.PublicInteractions": {
		label: "Accept mail commands in public chat",
		clientDefault: "false",
	},
	"ChatBot.Mailer.MaxMailsPerPlayer": { label: "Most mails held per player", clientDefault: "10" },
	"ChatBot.Mailer.MaxDatabaseSize": { label: "Most mails held in total", clientDefault: "10000" },
	"ChatBot.Mailer.MailRetentionDays": { label: "Days to keep a mail", clientDefault: "30" },
	"ChatBot.PlayerListLogger.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.PlayerListLogger.File": { label: "Player list file", clientDefault: "playerlog.txt" },
	"ChatBot.PlayerListLogger.Delay": { label: "Seconds between entries", clientDefault: "60.0" },
	"ChatBot.FollowPlayer.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.FollowPlayer.Update_Limit": {
		label: "Seconds between path updates",
		clientDefault: "1.5",
	},
	"ChatBot.FollowPlayer.Stop_At_Distance": {
		label: "Stop within this many blocks",
		clientDefault: "3.0",
	},
	"ChatBot.RemoteControl.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.RemoteControl.AutoTpaccept": {
		label: "Accept teleport requests",
		description:
			"OpenMCC keeps the bot-owner list empty, so this does nothing until the setting below is on.",
		clientDefault: "true",
	},
	"ChatBot.RemoteControl.AutoTpaccept_Everyone": {
		label: "Accept teleport requests from any player",
		description:
			"Any player on the server can teleport the bot to themselves just by sending it a request — no approval, and no need to be a bot owner. Does nothing unless 'Accept teleport requests' is also on.",
		clientDefault: "false",
	},
	"ChatBot.ReplayCapture.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.ReplayCapture.Backup_Interval": {
		label: "Seconds between snapshots",
		description: "Use -1 or 0 for none. The replay is still saved when recording stops.",
		clientDefault: "300.0",
	},
}

export type BotConfigEnumOption = {
	readonly value: string
	readonly label: string
}

export const BOT_CONFIG_LIST_NAMES: readonly BotConfigName[] = z
	.object(BOT_CONFIG_LIST_SHAPE)
	.keyof().options

export const BOT_CONFIG_ENUM_OPTIONS: Record<
	keyof typeof BOT_CONFIG_ENUM_SHAPE,
	readonly BotConfigEnumOption[]
> = {}

const DECLARED_ORDER: readonly string[] = Object.keys(BOT_CONFIG_FIELDS)

const SECTION_ORDER = [
	"Alerts",
	"Map",
	"Mailer",
	"PlayerListLogger",
	"FollowPlayer",
	"RemoteControl",
	"ReplayCapture",
] as const

export type BotConfigSectionName = (typeof SECTION_ORDER)[number]

export const BOT_CONFIG_SECTION_LABEL: Record<BotConfigSectionName, string> = {
	Alerts: "Alerts",
	Map: "Maps",
	Mailer: "Mail",
	PlayerListLogger: "Player list log",
	FollowPlayer: "Follow a player",
	RemoteControl: "Teleport requests",
	ReplayCapture: "Replay capture",
}

const BOT_CONFIG_OPTIONS = z
	.object(BOT_CONFIG_SHAPE)
	.keyof()
	.options.slice()
	.sort((left, right) => DECLARED_ORDER.indexOf(left) - DECLARED_ORDER.indexOf(right))

export type BotConfigSection = {
	readonly name: BotConfigSectionName
	readonly keys: readonly BotConfigName[]
}

const ENABLED_SUFFIX = ".Enabled"

const sectionNameOf = (key: BotConfigName): string => key.split(".")[1] ?? ""

const enabledFirst = (left: BotConfigName, right: BotConfigName): number => {
	const leftEnabled = left.endsWith(ENABLED_SUFFIX)
	const rightEnabled = right.endsWith(ENABLED_SUFFIX)
	if (leftEnabled === rightEnabled) return 0
	return leftEnabled ? -1 : 1
}

export const BOT_CONFIG_SECTIONS: readonly BotConfigSection[] = SECTION_ORDER.map((name) => ({
	name,
	keys: BOT_CONFIG_OPTIONS.filter((key) => sectionNameOf(key) === name).sort(enabledFirst),
}))

export const BOT_CONFIG_SECTION_PURPOSE: Record<BotConfigSectionName, string> = {
	Alerts: "Sound an alert on chosen words, rain or thunder.",
	Map: "Render in-game maps to the console or to image files.",
	Mailer: "Let players leave mail for each other through the bot.",
	PlayerListLogger: "Record who is online, at a set interval.",
	FollowPlayer: "Walk the bot after a named player.",
	RemoteControl: "Let players teleport the bot to them.",
	ReplayCapture: "Record the session to a replay file.",
}

export const INSTANCE_SETTING_LABELS = {
	worldDataEnabled: "World and position",
	entityDataEnabled: "Nearby entities",
} as const satisfies Partial<Record<keyof InstanceConfigInput, string>>

export type BotConfigInstanceSetting = keyof typeof INSTANCE_SETTING_LABELS

export type BotConfigDependency =
	| {
			readonly kind: "sibling"
			readonly keys: readonly BotConfigName[]
			readonly requires: BotConfigName
	  }
	| {
			readonly kind: "instance"
			readonly keys: readonly BotConfigName[]
			readonly requires: readonly BotConfigInstanceSetting[]
	  }

export const BOT_CONFIG_DEPENDENCIES: readonly BotConfigDependency[] = [
	{
		kind: "sibling",
		keys: ["ChatBot.Alerts.Matches", "ChatBot.Alerts.Excludes"],
		requires: "ChatBot.Alerts.Trigger_By_Words",
	},
	{
		kind: "sibling",
		keys: ["ChatBot.RemoteControl.AutoTpaccept_Everyone"],
		requires: "ChatBot.RemoteControl.AutoTpaccept",
	},
	{
		kind: "instance",
		keys: [
			"ChatBot.FollowPlayer.Enabled",
			"ChatBot.FollowPlayer.Update_Limit",
			"ChatBot.FollowPlayer.Stop_At_Distance",
		],
		requires: ["worldDataEnabled", "entityDataEnabled"],
	},
]

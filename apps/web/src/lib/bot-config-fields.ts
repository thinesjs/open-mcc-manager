import type { InstanceConfigInput } from "@open-mcc/contracts"
import {
	BOT_CONFIG_ENUM_SHAPE,
	BOT_CONFIG_LIST_SHAPE,
	BOT_CONFIG_SHAPE,
	type BotConfigName,
} from "@open-mcc/contracts/boundary/mcc-config-keys"
import { z } from "zod"

export type BotConfigField = {
	readonly label: string
	readonly description?: string
	readonly clientDefault: string | readonly string[]
}

export const BOT_CONFIG_FIELDS: Record<BotConfigName, BotConfigField> = {
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
	"ChatBot.Alerts.Log_To_File": { label: "Write alerts to a file", clientDefault: "false" },
	"ChatBot.Alerts.Log_File": { label: "Alert log file", clientDefault: "alerts-log.txt" },
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
	"ChatBot.Map.Save_To_File": { label: "Save maps as images", clientDefault: "false" },
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
	"ChatBot.Map.Rasize_Rendered_Image": { label: "Resize saved images", clientDefault: "false" },
	"ChatBot.Map.Resize_To": { label: "Image size in pixels", clientDefault: "512" },
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
	"ChatBot.ChatLog.Enabled": { label: "Enabled", clientDefault: "false" },
	"ChatBot.ChatLog.Add_DateTime": { label: "Timestamp each line", clientDefault: "true" },
	"ChatBot.ChatLog.Log_File": {
		label: "Chat log file",
		clientDefault: "chatlog.txt",
	},
	"ChatBot.ChatLog.Filter": { label: "Messages to log", clientDefault: "messages" },
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

const CHAT_LOG_FILTER_LABEL: Record<
	z.infer<(typeof BOT_CONFIG_ENUM_SHAPE)["ChatBot.ChatLog.Filter"]>,
	string
> = {
	all: "Everything",
	messages: "Chat and whispers",
	chat: "Public chat",
	private_chat: "Whispers",
	internal_msg: "Client messages",
}

export const BOT_CONFIG_LIST_NAMES: readonly BotConfigName[] = z
	.object(BOT_CONFIG_LIST_SHAPE)
	.keyof().options

export const BOT_CONFIG_ENUM_OPTIONS: Record<
	keyof typeof BOT_CONFIG_ENUM_SHAPE,
	readonly BotConfigEnumOption[]
> = {
	"ChatBot.ChatLog.Filter": BOT_CONFIG_ENUM_SHAPE["ChatBot.ChatLog.Filter"].options.map(
		(member) => ({ value: member, label: CHAT_LOG_FILTER_LABEL[member] }),
	),
}

const DECLARED_ORDER: readonly string[] = Object.keys(BOT_CONFIG_FIELDS)

const SECTION_ORDER = [
	"Alerts",
	"Map",
	"Mailer",
	"ChatLog",
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
	ChatLog: "Chat log",
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
	ChatLog: "Write chat to a file on the host.",
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
		keys: ["ChatBot.Alerts.Matches", "ChatBot.Alerts.Excludes", "ChatBot.Alerts.Log_To_File"],
		requires: "ChatBot.Alerts.Trigger_By_Words",
	},
	{
		kind: "sibling",
		keys: ["ChatBot.Alerts.Log_File"],
		requires: "ChatBot.Alerts.Log_To_File",
	},
	{
		kind: "sibling",
		keys: ["ChatBot.Map.Rasize_Rendered_Image"],
		requires: "ChatBot.Map.Save_To_File",
	},
	{
		kind: "sibling",
		keys: ["ChatBot.Map.Resize_To"],
		requires: "ChatBot.Map.Rasize_Rendered_Image",
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

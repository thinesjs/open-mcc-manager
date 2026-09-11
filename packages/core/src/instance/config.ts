import {
	type AccountType,
	type DelaySecondsRange,
	type InstanceConfigInput,
	isOfflineAccount,
} from "@open-mcc/contracts"
import type { AdvancedKeys, BotConfig } from "@open-mcc/contracts/boundary/mcc-config-keys"
import {
	LIST_CONFIG_NAMES,
	QUOTED_CONFIG_NAMES,
} from "@open-mcc/contracts/boundary/mcc-config-keys"

export const OFFLINE_PASSWORD = "-"

export const MCC_LOGIN_TYPES: Record<AccountType, string> = {
	microsoft: "microsoft",
	offline: "microsoft",
}

export const ALLOWED_CONFIG_KEYS = [
	"Main.General.AccountType",
	"Main.General.Account.Login",
	"Main.General.Account.Password",
	"Main.General.Server.Host",
	"Main.General.Server.Port",
	"Main.Advanced.AutoRespawn",
	"ChatBot.McpServer.Enabled",
	"ChatBot.McpServer.Transport.Port",
	"Main.Advanced.TerrainAndMovements",
	"Main.Advanced.InventoryHandling",
	"Main.Advanced.EntityHandling",
	"ChatBot.McpServer.Capabilities.SessionStatus",
	"ChatBot.McpServer.Capabilities.Inventory",
	"ChatBot.McpServer.Capabilities.EntityWorld",
	"ChatBot.AutoRelog.Enabled",
	"ChatBot.AutoRelog.Retries",
	"ChatBot.AutoRelog.Delay",
	"ChatBot.AntiAFK.Enabled",
	"ChatBot.AntiAFK.Delay",
] as const

export const FIXED_CONFIG_KEYS = [
	"Main.Advanced.EnableSentry",
	"Main.Advanced.ShowGithubStarReminder",
	"Console.General.ConsoleMode",
	"Logging.LogToFile",
	"Main.Advanced.ExitOnFailure",
	"Main.Advanced.IgnoreInvalidPlayerName",
	"Main.Advanced.InternalCmdChar",
	"Main.General.Method",
	"ChatBot.McpServer.Transport.BindHost",
	"ChatBot.McpServer.Transport.Route",
	"ChatBot.McpServer.Transport.RequireAuthToken",
	"ChatBot.McpServer.Transport.AuthTokenEnvVar",
	"ChatBot.McpServer.Capabilities.ChatAndCommands",
	"ChatBot.McpServer.Capabilities.Movement",
	"Main.Advanced.BotOwners",
	"ChatBot.Map.Send_Rendered_To_Discord",
	"ChatBot.Map.Send_Rendered_To_Telegram",
	"ChatBot.AutoRespond.Enabled",
	"ChatBot.ScriptScheduler.Enabled",
	"ChatBot.DiscordBridge.Enabled",
	"ChatBot.TelegramBridge.Enabled",
] as const

export const LIVE_CONTROL_BIND_HOST = "127.0.0.1"

export const LIVE_CONTROL_ROUTE = "/mcp"

export const LIVE_CONTROL_TOKEN_ENV = "MCC_MCP_AUTH_TOKEN"

export const EMPTIED_CONFIG_SECTIONS = [
	"Main.Advanced.AccountList",
	"Main.Advanced.ServerList",
] as const

export const CONSOLE_MODE = "classic"

export const INTERNAL_CMD_CHAR = "slash"

export const LOGIN_METHOD = "mcc"

const TOML_ESCAPES: Record<string, string> = {
	"\\": "\\\\",
	'"': '\\"',
	"\n": "\\n",
	"\r": "\\r",
	"\t": "\\t",
	"\b": "\\b",
	"\f": "\\f",
}

const tomlString = (value: string): string => {
	let rendered = '"'
	for (const character of value) {
		const escaped = TOML_ESCAPES[character]
		if (escaped !== undefined) {
			rendered += escaped
			continue
		}
		const code = character.charCodeAt(0)
		if (code < 0x20 || code === 0x7f) {
			rendered += `\\u${code.toString(16).padStart(4, "0")}`
			continue
		}
		rendered += character
	}
	return `${rendered}"`
}

const tomlInt = (value: number): string => {
	if (!Number.isInteger(value)) throw new Error("Config integers must be whole numbers")
	return String(value)
}

const tomlBool = (value: boolean): string => (value ? "true" : "false")

const serverLines = (address: string): string[] => {
	const { host, port } = splitServerAddress(address)
	return port === undefined
		? [`Host = ${tomlString(host)}`]
		: [`Host = ${tomlString(host)}`, `Port = ${tomlInt(port)}`]
}

const tomlSecondsRange = (range: DelaySecondsRange): string => {
	if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min < 0) {
		throw new Error("Config delays must be a non-negative number of seconds")
	}
	return `{ min = ${range.min.toFixed(1)}, max = ${range.max.toFixed(1)} }`
}

export const DEFAULT_AUTO_RELOG_RETRIES = 3

export const DEFAULT_AUTO_RELOG_DELAY_SECONDS: DelaySecondsRange = { min: 10, max: 10 }

export const DEFAULT_ANTI_AFK_INTERVAL_SECONDS: DelaySecondsRange = { min: 60, max: 60 }

export const DEFAULT_LIVE_CONTROL_PORT = 33333

export const LIVE_CONTROL_PORT_LIMIT = 33832

export class LiveControlPortsExhaustedError extends Error {}

export const freeLiveControlPorts = function* (taken: Iterable<number>): Generator<number> {
	const used = new Set(taken)
	for (let port = DEFAULT_LIVE_CONTROL_PORT; port <= LIVE_CONTROL_PORT_LIMIT; port += 1) {
		if (!used.has(port)) yield port
	}
}

export const defaultInstanceConfig = (values: {
	accountType: AccountType
	minecraftAccount: string
	serverAddress: string
}): InstanceConfigInput => ({
	accountType: values.accountType,
	minecraftAccount: values.minecraftAccount,
	serverAddress: values.serverAddress,
	autoRelogRetries: DEFAULT_AUTO_RELOG_RETRIES,
	autoRelogEnabled: true,
	autoRelogDelaySeconds: DEFAULT_AUTO_RELOG_DELAY_SECONDS,
	antiAfkEnabled: false,
	antiAfkIntervalSeconds: DEFAULT_ANTI_AFK_INTERVAL_SECONDS,
	autoRespawnEnabled: false,
	liveControlEnabled: false,
	liveControlPort: DEFAULT_LIVE_CONTROL_PORT,
	worldDataEnabled: false,
	inventoryDataEnabled: false,
	entityDataEnabled: false,
	advancedKeys: {},
	botConfig: {},
})

export type ServerAddress = { host: string; port: number | undefined }

export const splitServerAddress = (value: string): ServerAddress => {
	const separator = value.lastIndexOf(":")
	if (separator <= 0 || value.includes("]")) return { host: value, port: undefined }
	const port = Number(value.slice(separator + 1))
	if (!Number.isInteger(port) || port < 1 || port > 65535) return { host: value, port: undefined }
	return { host: value.slice(0, separator), port }
}

const PINNED_BOT_CONFIG: Readonly<Record<string, string>> = {
	"ChatBot.Map.Send_Rendered_To_Discord": "false",
	"ChatBot.Map.Send_Rendered_To_Telegram": "false",
}

const renderConfigValue = (key: string, value: string | readonly string[]): string => {
	if (LIST_CONFIG_NAMES.includes(key)) {
		const entries = typeof value === "string" ? [value] : value
		return entries.length === 0 ? "[]" : `[ ${entries.map(tomlString).join(", ")} ]`
	}
	const single = typeof value === "string" ? value : (value[0] ?? "")
	return QUOTED_CONFIG_NAMES.includes(key) ? tomlString(single) : single
}

const renderConfigTables = (
	advancedKeys: AdvancedKeys,
	botConfig: BotConfig,
): readonly string[] => {
	const tables = new Map<string, string[]>()
	const entries: [string, string | readonly string[]][] = [
		...Object.entries(advancedKeys),
		...Object.entries(botConfig),
		...Object.entries(PINNED_BOT_CONFIG),
	].flatMap(([key, value]) => (value === undefined ? [] : [[key, value]]))
	for (const [key, value] of entries) {
		const separator = key.lastIndexOf(".")
		const assignment = `${key.slice(separator + 1)} = ${renderConfigValue(key, value)}`
		const table = key.slice(0, separator)
		const lines = tables.get(table)
		if (lines === undefined) tables.set(table, [assignment])
		else lines.push(assignment)
	}
	return [...tables.keys()].sort().flatMap((table) => {
		const lines = tables.get(table) ?? []
		return [`[${table}]`, ...[...lines].sort(), ""]
	})
}

export const renderInstanceConfig = (config: InstanceConfigInput): string =>
	[
		"[Main.General]",
		`AccountType = ${tomlString(MCC_LOGIN_TYPES[config.accountType])}`,
		`Method = ${tomlString(LOGIN_METHOD)}`,
		"",
		"[Main.General.Account]",
		`Login = ${tomlString(config.minecraftAccount)}`,
		`Password = ${tomlString(isOfflineAccount(config.accountType) ? OFFLINE_PASSWORD : "")}`,
		"",
		"[Main.General.Server]",
		...serverLines(config.serverAddress),
		"",
		"[Main.Advanced]",
		`EnableSentry = ${tomlBool(false)}`,
		`ExitOnFailure = ${tomlBool(true)}`,
		`IgnoreInvalidPlayerName = ${tomlBool(true)}`,
		`InternalCmdChar = ${tomlString(INTERNAL_CMD_CHAR)}`,
		`ShowGithubStarReminder = ${tomlBool(false)}`,
		"BotOwners = []",
		`AutoRespawn = ${tomlBool(config.autoRespawnEnabled)}`,
		`TerrainAndMovements = ${tomlBool(config.worldDataEnabled)}`,
		`InventoryHandling = ${tomlBool(config.inventoryDataEnabled)}`,
		`EntityHandling = ${tomlBool(config.entityDataEnabled)}`,
		"",
		"[Main.Advanced.AccountList]",
		"",
		"[Main.Advanced.ServerList]",
		"",
		"[ChatBot.AutoRelog]",
		`Enabled = ${tomlBool(config.autoRelogEnabled)}`,
		`Retries = ${tomlInt(config.autoRelogRetries)}`,
		`Delay = ${tomlSecondsRange(config.autoRelogDelaySeconds)}`,
		"",
		"[ChatBot.AntiAFK]",
		`Enabled = ${tomlBool(config.antiAfkEnabled)}`,
		`Delay = ${tomlSecondsRange(config.antiAfkIntervalSeconds)}`,
		"",
		"[ChatBot.McpServer]",
		`Enabled = ${tomlBool(config.liveControlEnabled)}`,
		"",
		"[ChatBot.McpServer.Transport]",
		`BindHost = ${tomlString(LIVE_CONTROL_BIND_HOST)}`,
		`Port = ${tomlInt(config.liveControlPort)}`,
		`Route = ${tomlString(LIVE_CONTROL_ROUTE)}`,
		`RequireAuthToken = ${tomlBool(true)}`,
		`AuthTokenEnvVar = ${tomlString(LIVE_CONTROL_TOKEN_ENV)}`,
		"",
		"[ChatBot.McpServer.Capabilities]",
		`SessionStatus = ${tomlBool(config.liveControlEnabled)}`,
		`ChatAndCommands = ${tomlBool(false)}`,
		`Movement = ${tomlBool(false)}`,
		`Inventory = ${tomlBool(config.liveControlEnabled && config.inventoryDataEnabled)}`,
		`EntityWorld = ${tomlBool(config.liveControlEnabled && config.entityDataEnabled)}`,
		"",
		"[Console.General]",
		`ConsoleMode = ${tomlString(CONSOLE_MODE)}`,
		"",
		"[Logging]",
		`LogToFile = ${tomlBool(false)}`,
		"",
		"[ChatBot.AutoRespond]",
		`Enabled = ${tomlBool(false)}`,
		"",
		"[ChatBot.ScriptScheduler]",
		`Enabled = ${tomlBool(false)}`,
		"",
		"[ChatBot.DiscordBridge]",
		`Enabled = ${tomlBool(false)}`,
		"",
		"[ChatBot.TelegramBridge]",
		`Enabled = ${tomlBool(false)}`,
		"",
		...renderConfigTables(config.advancedKeys, config.botConfig),
	].join("\n")

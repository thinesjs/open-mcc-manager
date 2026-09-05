import { type AccountType, type InstanceConfigInput, isOfflineAccount } from "@open-mcc/contracts"

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
	"ChatBot.AutoRelog.Enabled",
	"ChatBot.AutoRelog.Retries",
	"ChatBot.AutoRelog.Delay",
	"ChatBot.AntiAFK.Enabled",
	"ChatBot.AntiAFK.Delay",
] as const

export const FIXED_CONFIG_KEYS = [
	"Main.Advanced.EnableSentry",
	"Main.Advanced.ExitOnFailure",
	"Main.Advanced.InternalCmdChar",
] as const

export const INTERNAL_CMD_CHAR = "slash"

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

const tomlSecondsRange = (seconds: number): string => {
	if (!Number.isFinite(seconds) || seconds < 0) {
		throw new Error("Config delays must be a non-negative number of seconds")
	}
	const asFloat = seconds.toFixed(1)
	return `{ min = ${asFloat}, max = ${asFloat} }`
}

export const DEFAULT_AUTO_RELOG_RETRIES = 3

export const DEFAULT_AUTO_RELOG_DELAY_SECONDS = 10

export const DEFAULT_ANTI_AFK_INTERVAL_SECONDS = 60

export const defaultInstanceConfig = (values: {
	accountType: AccountType
	minecraftAccount: string
	serverAddress: string
}): InstanceConfigInput => ({
	accountType: values.accountType,
	minecraftAccount: values.minecraftAccount,
	serverAddress: values.serverAddress,
	autoRelogRetries: DEFAULT_AUTO_RELOG_RETRIES,
	autoRelogDelaySeconds: DEFAULT_AUTO_RELOG_DELAY_SECONDS,
	antiAfkEnabled: false,
	antiAfkIntervalSeconds: DEFAULT_ANTI_AFK_INTERVAL_SECONDS,
})

export const renderInstanceConfig = (config: InstanceConfigInput): string =>
	[
		"[Main.General]",
		`AccountType = ${tomlString(MCC_LOGIN_TYPES[config.accountType])}`,
		"",
		"[Main.General.Account]",
		`Login = ${tomlString(config.minecraftAccount)}`,
		`Password = ${tomlString(isOfflineAccount(config.accountType) ? OFFLINE_PASSWORD : "")}`,
		"",
		"[Main.General.Server]",
		`Host = ${tomlString(config.serverAddress)}`,
		"",
		"[Main.Advanced]",
		`EnableSentry = ${tomlBool(false)}`,
		`ExitOnFailure = ${tomlBool(true)}`,
		`InternalCmdChar = ${tomlString(INTERNAL_CMD_CHAR)}`,
		"",
		"[ChatBot.AutoRelog]",
		`Enabled = ${tomlBool(true)}`,
		`Retries = ${tomlInt(config.autoRelogRetries)}`,
		`Delay = ${tomlSecondsRange(config.autoRelogDelaySeconds)}`,
		"",
		"[ChatBot.AntiAFK]",
		`Enabled = ${tomlBool(config.antiAfkEnabled)}`,
		`Delay = ${tomlSecondsRange(config.antiAfkIntervalSeconds)}`,
		"",
	].join("\n")

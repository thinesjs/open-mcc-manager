import type { InstanceConfigInput } from "@open-mcc/contracts"

export const ALLOWED_CONFIG_KEYS = [
	"Main.General.Account.Login",
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
] as const

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

export const renderInstanceConfig = (config: InstanceConfigInput): string =>
	[
		"[Main.General.Account]",
		`Login = ${tomlString(config.minecraftAccount)}`,
		"",
		"[Main.General.Server]",
		`Host = ${tomlString(config.serverAddress)}`,
		"",
		"[Main.Advanced]",
		`EnableSentry = ${tomlBool(false)}`,
		`ExitOnFailure = ${tomlBool(true)}`,
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

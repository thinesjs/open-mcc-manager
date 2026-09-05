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

const tomlString = (value: string): string =>
	`"${value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t")}"`

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

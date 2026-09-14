import type { HostTransport } from "@open-mcc/transport"
import { journalctl } from "../host/profile"
import { instanceDir, unitName, validateInstanceId } from "./unit"

export const CONTROL_TIMEOUT_MS = 15_000

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

const controlPath = (instanceId: string): string => `${instanceDir(instanceId)}/control`

export const INTERNAL_COMMANDS = [
	"achievement",
	"animation",
	"bed",
	"blockinfo",
	"changeslot",
	"chunk",
	"dialog",
	"dig",
	"dropitem",
	"effects",
	"enchant",
	"entity",
	"exit",
	"follow",
	"health",
	"help",
	"inventory",
	"list",
	"look",
	"minimap",
	"move",
	"nameitem",
	"recipebook",
	"reco",
	"respawn",
	"sneak",
	"tab",
	"teams",
	"tps",
	"useblock",
	"useitem",
] as const

const INTERNAL_COMMAND_SET: ReadonlySet<string> = new Set(INTERNAL_COMMANDS)

export const ARGUMENT_FREE_COMMANDS = ["reco"] as const

const ARGUMENT_FREE_SET: ReadonlySet<string> = new Set(ARGUMENT_FREE_COMMANDS)

export const INTERNAL_COMMAND_PREFIX = "!"

const hasControlCharacter = (value: string): boolean => {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0
		if (code < 0x20 || code === 0x7f) return true
	}
	return false
}

export class DisallowedInternalCommandError extends Error {}

export const controlLine = (input: string): string => {
	if (!input.startsWith(INTERNAL_COMMAND_PREFIX)) {
		return input.startsWith("/") ? `/${input}` : input
	}
	const words = input.slice(INTERNAL_COMMAND_PREFIX.length).trim().split(/\s+/)
	const name = words[0]?.toLowerCase() ?? ""
	if (!INTERNAL_COMMAND_SET.has(name)) {
		throw new DisallowedInternalCommandError(
			`The client command '${name}' is not one this manager will run`,
		)
	}
	const args = words.slice(1)
	if (args.length > 0 && ARGUMENT_FREE_SET.has(name)) {
		throw new DisallowedInternalCommandError(
			`The client command '${name}' does not take an argument here`,
		)
	}
	return `/${[name, ...args].join(" ")}`
}

export const sendCommand = async (
	transport: HostTransport,
	instanceId: string,
	command: string,
): Promise<void> => {
	const id = validateInstanceId(instanceId)
	if (hasControlCharacter(command)) {
		throw new Error("Instance commands must not contain a control character")
	}
	const line = controlLine(command)
	const result = await transport.exec(`cat > ${controlPath(id)}`, CONTROL_TIMEOUT_MS, `${line}\n`)
	if (result.exitCode !== 0) {
		throw new Error(`Failed to send command to instance ${id}: ${result.stderr.trim()}`)
	}
}

export const readConsole = async (
	transport: HostTransport,
	instanceId: string,
	lines: number,
): Promise<string> => {
	const id = validateInstanceId(instanceId)
	if (!Number.isInteger(lines) || lines < 1 || lines > 1000) {
		throw new Error("Console line count must be a whole number between 1 and 1000")
	}
	const result = await transport.exec(
		journalctl(
			`-u ${shellQuote(`${unitName(id)}.service`)} --lines ${lines} --no-pager --output cat`,
		),
		CONTROL_TIMEOUT_MS,
	)
	if (result.exitCode !== 0) {
		throw new Error(`Failed to read console for instance ${id}: ${result.stderr.trim()}`)
	}
	return result.stdout
}

import type { HostTransport } from "@open-mcc/transport"
import { type HostProfile, journalctl } from "../host/profile"
import { instanceDir, unitName, validateInstanceId } from "./unit"

export const CONTROL_TIMEOUT_MS = 15_000

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

const controlPath = (instancesRoot: string, instanceId: string): string =>
	`${instanceDir(instancesRoot, instanceId)}/control`

export const INTERNAL_COMMANDS = [
	"achievement",
	"animation",
	"bed",
	"blockinfo",
	"book",
	"changeslot",
	"chunk",
	"dialog",
	"dig",
	"dropitem",
	"effects",
	"enchant",
	"entity",
	"exit",
	"health",
	"help",
	"inventory",
	"list",
	"log",
	"look",
	"minimap",
	"move",
	"nameitem",
	"recipebook",
	"reco",
	"respawn",
	"setrnd",
	"sneak",
	"tab",
	"teams",
	"tps",
	"useblock",
	"useitem",
] as const

const INTERNAL_COMMAND_SET: ReadonlySet<string> = new Set(INTERNAL_COMMANDS)

export const INTERNAL_COMMAND_PREFIX = "!"

export class DisallowedInternalCommandError extends Error {}

export const controlLine = (input: string): string => {
	if (!input.startsWith(INTERNAL_COMMAND_PREFIX)) {
		return input.startsWith("/") ? `/${input}` : input
	}
	const body = input.slice(INTERNAL_COMMAND_PREFIX.length).trimStart()
	const name = body.split(/\s+/)[0]?.toLowerCase() ?? ""
	if (!INTERNAL_COMMAND_SET.has(name)) {
		throw new DisallowedInternalCommandError(
			`The client command '${name}' is not one this manager will run`,
		)
	}
	return `/${body}`
}

export const sendCommand = async (
	transport: HostTransport,
	instanceId: string,
	command: string,
	instancesRoot: string,
): Promise<void> => {
	const id = validateInstanceId(instanceId)
	if (/[\n\r]/.test(command)) {
		throw new Error("Instance commands must not contain a newline")
	}
	const line = controlLine(command)
	const result = await transport.exec(
		`cat > ${shellQuote(controlPath(instancesRoot, id))}`,
		CONTROL_TIMEOUT_MS,
		`${line}\n`,
	)
	if (result.exitCode !== 0) {
		throw new Error(`Failed to send command to instance ${id}: ${result.stderr.trim()}`)
	}
}

export const readConsole = async (
	transport: HostTransport,
	instanceId: string,
	lines: number,
	profile: HostProfile,
): Promise<string> => {
	const id = validateInstanceId(instanceId)
	if (!Number.isInteger(lines) || lines < 1 || lines > 1000) {
		throw new Error("Console line count must be a whole number between 1 and 1000")
	}
	const result = await transport.exec(
		journalctl(
			profile,
			`-u ${shellQuote(`${unitName(id)}.service`)} --lines ${lines} --no-pager --output cat`,
		),
		CONTROL_TIMEOUT_MS,
	)
	if (result.exitCode !== 0) {
		throw new Error(`Failed to read console for instance ${id}: ${result.stderr.trim()}`)
	}
	return result.stdout
}

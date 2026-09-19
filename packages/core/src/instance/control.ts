import { maskCommandCredentials } from "@open-mcc/contracts"
import type { HostTransport } from "@open-mcc/transport"
import { HostRefusedError, InternalError } from "../lib/errors"
import { instanceDir, validateInstanceId } from "./unit"

export const CONTROL_TIMEOUT_MS = 15_000

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

export class DoubleSlashCredentialError extends Error {}

export class StoredCredentialError extends Error {}

const refuseDoubleSlashCredential = (command: string): void => {
	if (!command.startsWith("//") || maskCommandCredentials(command) === command) return
	throw new DoubleSlashCredentialError(
		"A credential command written with two slashes never reaches the server",
	)
}

export const refuseStoredCredential = (command: string): void => {
	if (maskCommandCredentials(command) === command) return
	throw new StoredCredentialError(
		"A command that could carry a credential is not stored, where every member could read it",
	)
}

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

export const sendableLine = (command: string): string => {
	if (hasControlCharacter(command)) {
		throw new InternalError("Instance commands must not contain a control character")
	}
	refuseDoubleSlashCredential(command)
	return controlLine(command)
}

export const sendCommand = async (
	transport: HostTransport,
	instanceId: string,
	command: string,
): Promise<void> => {
	const id = validateInstanceId(instanceId)
	const line = sendableLine(command)
	const result = await transport.exec(`cat > ${controlPath(id)}`, CONTROL_TIMEOUT_MS, `${line}\n`)
	if (result.exitCode !== 0) {
		throw new HostRefusedError(`Failed to send command to instance ${id}: ${result.stderr.trim()}`)
	}
}

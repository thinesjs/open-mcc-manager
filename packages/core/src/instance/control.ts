import type { HostTransport } from "@open-mcc/transport"
import { validateInstanceId } from "./unit"

export const CONTROL_TIMEOUT_MS = 15_000

export const DEFAULT_INSTANCES_ROOT = "/srv/open-mcc"

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

const controlPath = (instancesRoot: string, instanceId: string): string =>
	`${instancesRoot}/instances/${instanceId}/control`

export const sendCommand = async (
	transport: HostTransport,
	instanceId: string,
	command: string,
	instancesRoot: string = DEFAULT_INSTANCES_ROOT,
): Promise<void> => {
	const id = validateInstanceId(instanceId)
	if (/[\n\r]/.test(command)) {
		throw new Error("Instance commands must not contain a newline")
	}
	const result = await transport.exec(
		`cat > ${shellQuote(controlPath(instancesRoot, id))}`,
		CONTROL_TIMEOUT_MS,
		`${command}\n`,
	)
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
		`journalctl -u ${shellQuote(`open-mcc@${id}`)} --lines ${lines} --no-pager --output cat`,
		CONTROL_TIMEOUT_MS,
	)
	if (result.exitCode !== 0) {
		throw new Error(`Failed to read console for instance ${id}: ${result.stderr.trim()}`)
	}
	return result.stdout
}

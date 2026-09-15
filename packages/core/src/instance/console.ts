import { asReadCommand, type HostReader } from "@open-mcc/transport"
import { journalctl } from "../host/profile"
import { unitName, validateInstanceId } from "./unit"

export const CONSOLE_READ_DEADLINE_MS = 15_000

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const readConsole = async (
	reader: Pick<HostReader, "exec">,
	instanceId: string,
	lines: number,
): Promise<string> => {
	const id = validateInstanceId(instanceId)
	if (!Number.isInteger(lines) || lines < 1 || lines > 1000) {
		throw new Error("Console line count must be a whole number between 1 and 1000")
	}
	const result = await reader.exec(
		asReadCommand(
			journalctl(
				`-u ${shellQuote(`${unitName(id)}.service`)} --lines ${lines} --no-pager --output cat`,
			),
		),
	)
	if (result.exitCode !== 0) {
		throw new Error(`Failed to read console for instance ${id}: ${result.stderr.trim()}`)
	}
	return result.stdout
}

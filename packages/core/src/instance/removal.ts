import { systemctl } from "../host/profile"
import { instanceDir, stopAuthCommand, unitName } from "./unit"

export const UNIT_STOP_TIMEOUT_MS = 45_000

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const stopUnitCommands = (instanceId: string): string[] => {
	const unit = shellQuote(`${unitName(instanceId)}.service`)
	return [
		["stop", "disable", "reset-failed"]
			.map((verb) => `${systemctl(`${verb} ${unit}`)} || true`)
			.join("; "),
		stopAuthCommand(instanceId),
	]
}

export const processesGoneCommand = (instanceId: string): string =>
	`real=$(cd ${instanceDir(instanceId)} 2>/dev/null && pwd -P) || exit 0; for process in /proc/[0-9]*; do case "$(readlink "$process/cwd" 2>/dev/null)" in "$real"|"$real"/*) exit 1;; esac; done; exit 0`

export const removeDirectoryCommand = (instanceId: string): string =>
	`rm -rf -- ${instanceDir(instanceId)}`

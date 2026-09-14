import { type HostProfile, systemctl, usesPerInstanceUsers } from "../host/profile"
import { instanceDir, instanceUser, stopAuthCommand, unitName } from "./unit"

export const UNIT_STOP_TIMEOUT_MS = 45_000

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const stopUnitCommands = (profile: HostProfile, instanceId: string): string[] => {
	const unit = shellQuote(`${unitName(instanceId)}.service`)
	return [
		["stop", "disable", "reset-failed"]
			.map((verb) => `${systemctl(profile, `${verb} ${unit}`)} || true`)
			.join("; "),
		stopAuthCommand(profile, instanceId),
	]
}

export const processesGoneCommand = (profile: HostProfile, instanceId: string): string => {
	if (usesPerInstanceUsers(profile)) {
		const account = shellQuote(instanceUser(instanceId))
		return `id -u ${account} >/dev/null 2>&1 || exit 0; pkill -KILL -u ${account}; for attempt in 1 2 3 4 5; do pgrep -u ${account} >/dev/null; [ $? -eq 1 ] && exit 0; sleep 1; done; exit 1`
	}
	const dir = shellQuote(instanceDir(profile.instancesRoot, instanceId))
	return `real=$(cd ${dir} 2>/dev/null && pwd -P) || exit 0; for process in /proc/[0-9]*; do case "$(readlink "$process/cwd" 2>/dev/null)" in "$real"|"$real"/*) exit 1;; esac; done; exit 0`
}

export const removeDirectoryCommand = (profile: HostProfile, instanceId: string): string =>
	`rm -rf -- ${shellQuote(instanceDir(profile.instancesRoot, instanceId))}`

export const removeAccountCommand = (instanceId: string): string => {
	const account = shellQuote(instanceUser(instanceId))
	return `if id -u ${account} >/dev/null 2>&1; then userdel ${account} || exit 1; fi; ! getent group ${account} >/dev/null || groupdel ${account}`
}

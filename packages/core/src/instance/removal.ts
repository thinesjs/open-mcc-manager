import { type HostProfile, systemctl } from "../host/profile"
import { authUnitName, instanceDir, instanceUser, unitName } from "./unit"

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const stopUnitCommands = (profile: HostProfile, instanceId: string): string[] =>
	[`${unitName(instanceId)}.service`, authUnitName(instanceId)].map((unit) =>
		["stop", "disable", "reset-failed"]
			.map((verb) => `${systemctl(profile, `${verb} ${shellQuote(unit)}`)} || true`)
			.join("; "),
	)

export const processesGoneCommand = (profile: HostProfile, instanceId: string): string => {
	if (profile.mode === "system") {
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
	return `id -u ${account} >/dev/null 2>&1 || exit 0; userdel ${account}`
}

import { withDeadline } from "../host/deadline"
import { podman, systemctl, UNIT_DIR } from "../host/profile"
import { sleepStartTimer, sleepStopTimer } from "./schedule"
import { authUnitName, instanceDir, unitName, validateInstanceId } from "./unit"

export const REMOVAL_STEP_TIMEOUT_MS = 15_000

export const UNIT_STOP_TIMEOUT_MS = 45_000

export const DIRECTORY_DELETE_TIMEOUT_MS = 40_000

const CONTAINERS_KILL_AFTER_SECONDS = 3

const CONTAINERS_DEADLINE_SECONDS = 10

const DIRECTORY_KILL_AFTER_SECONDS = 5

const DIRECTORY_DEADLINE_SECONDS = 30

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

const unitsOf = (instanceId: string): string =>
	[`${unitName(instanceId)}.service`, authUnitName(instanceId)].map(shellQuote).join(" ")

const containersOf = (instanceId: string): string =>
	`open-mcc-${validateInstanceId(instanceId)} open-mcc-auth-${validateInstanceId(instanceId)}`

export const removeTimersCommand = (instanceId: string): string => {
	const timers = [sleepStopTimer(instanceId), sleepStartTimer(instanceId)].map(shellQuote).join(" ")
	return `for timer in ${timers}; do if [ -e ${UNIT_DIR}/"$timer" ]; then ${systemctl('disable --now "$timer"')} || exit 1; fi; rm -f -- ${UNIT_DIR}/"$timer" || exit 1; done; ${systemctl("daemon-reload")}`
}

export const stopUnitsCommand = (instanceId: string): string =>
	systemctl(`stop ${unitsOf(instanceId)}`)

export const removeContainersCommand = (instanceId: string): string =>
	withDeadline(
		CONTAINERS_KILL_AFTER_SECONDS,
		CONTAINERS_DEADLINE_SECONDS,
		`podman rm -f --ignore ${containersOf(instanceId)}`,
	)

export const verifyGoneCommand = (instanceId: string): string =>
	[
		"failed=",
		`for unit in ${unitsOf(instanceId)}; do state=$(${systemctl('show -p ActiveState --value "$unit"')}) || exit 1; case "$state" in inactive) ;; failed) failed="$failed $unit" ;; *) exit 1 ;; esac; done`,
		`for name in ${containersOf(instanceId)}; do ${podman('container exists "$name"')}; case $? in 1) ;; *) exit 1 ;; esac; done`,
		`[ -z "$failed" ] || ${systemctl("reset-failed $failed")}`,
	].join("; ")

export const deleteDirectoryCommand = (instanceId: string): string => {
	const directory = instanceDir(instanceId)
	return withDeadline(
		DIRECTORY_KILL_AFTER_SECONDS,
		DIRECTORY_DEADLINE_SECONDS,
		`sh -c '[ ! -e ${directory} ] || { chmod -R u+rwX -- ${directory} && rm -rf -- ${directory}; }'`,
	)
}

export type { HealthInput, HostHealth } from "@open-mcc/contracts"
export { HEALTH_POLL_MS, HOST_HEALTH, healthFor, OFFLINE_AFTER_MS } from "@open-mcc/contracts"

import { asReadCommand, type HostReader } from "@open-mcc/transport"
import { OS_RELEASE_COMMAND, parseOsRelease } from "./facts"
import { systemctl } from "./profile"

export const HEALTH_TIMEOUT_MS = 15_000

export const failedUnitsCommand = (): string =>
	`${systemctl("list-units 'open-mcc*' --state=failed --no-legend --plain")} 2>/dev/null | grep -c . || printf 0`

export const parseFailedUnits = (output: string): number => {
	const value = Number.parseInt(output.trim(), 10)
	return Number.isSafeInteger(value) && value > 0 ? value : 0
}

export type HostObservationResult = {
	reachable: boolean
	failedUnits: number
	osId: string | null
	osName: string | null
}

export const observeHost = async (
	reader: Pick<HostReader, "exec">,
): Promise<HostObservationResult> => {
	const failed = await reader.exec(asReadCommand(failedUnitsCommand()))
	const os = await reader.exec(asReadCommand(OS_RELEASE_COMMAND))
	return {
		reachable: true,
		failedUnits: parseFailedUnits(failed.stdout),
		...parseOsRelease(os.stdout),
	}
}

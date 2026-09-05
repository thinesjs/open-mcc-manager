export type { HealthInput, HostHealth } from "@open-mcc/contracts"
export { HEALTH_POLL_MS, HOST_HEALTH, healthFor, OFFLINE_AFTER_MS } from "@open-mcc/contracts"

import type { HostTransport } from "@open-mcc/transport"
import { OS_RELEASE_COMMAND, parseOsRelease } from "./facts"
import { type HostProfile, systemctl } from "./profile"

export const HEALTH_TIMEOUT_MS = 15_000

export const failedUnitsCommand = (profile: HostProfile): string =>
	`${systemctl(profile, "list-units 'open-mcc*' --state=failed --no-legend --plain")} 2>/dev/null | grep -c . || printf 0`

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
	transport: HostTransport,
	profile: HostProfile,
): Promise<HostObservationResult> => {
	const failed = await transport.exec(failedUnitsCommand(profile), HEALTH_TIMEOUT_MS)
	const os = await transport.exec(OS_RELEASE_COMMAND, HEALTH_TIMEOUT_MS)
	return {
		reachable: true,
		failedUnits: parseFailedUnits(failed.stdout),
		...parseOsRelease(os.stdout),
	}
}

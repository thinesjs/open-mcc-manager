export type { HealthInput, HostHealth } from "@open-mcc/contracts"
export { HEALTH_POLL_MS, HOST_HEALTH, healthFor, OFFLINE_AFTER_MS } from "@open-mcc/contracts"

import { asReadCommand, type HostReader } from "@open-mcc/transport"
import { OS_RELEASE_COMMAND, parseOsRelease } from "./facts"
import { systemctl } from "./profile"

export const HEALTH_TIMEOUT_MS = 15_000

export const failedUnitsCommand = (): string =>
	systemctl("list-units 'open-mcc*' --state=failed --no-legend --plain")

export const parseFailedUnits = (output: string): number =>
	output.split("\n").filter((line) => line.trim().length > 0).length

export type HostObservationResult = {
	failedUnits: number | null
	osId: string | null
	osName: string | null
}

export const observeHost = async (
	reader: Pick<HostReader, "exec">,
): Promise<HostObservationResult> => {
	const failed = await reader.exec(asReadCommand(failedUnitsCommand()))
	const os = await reader.exec(asReadCommand(OS_RELEASE_COMMAND))
	return {
		failedUnits: failed.exitCode === 0 ? parseFailedUnits(failed.stdout) : null,
		...parseOsRelease(os.stdout),
	}
}

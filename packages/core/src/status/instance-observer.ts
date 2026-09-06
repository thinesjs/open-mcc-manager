import { connectionSignals, parseJournal } from "@open-mcc/contracts/boundary/journal"
import type { HostTransport } from "@open-mcc/transport"
import { type HostProfile, journalctl } from "../host/profile"
import { unitName } from "../instance/unit"
import { type ConnectionChange, type ConnectionCurrent, changesFromSignals } from "./connection"

export const JOURNAL_READ_TIMEOUT_MS = 20_000

export const JOURNAL_MAX_LINES = 2_000

export const journalSince = (cursor: string | null): string => (cursor === null ? "-30min" : cursor)

export const journalCommand = (
	profile: HostProfile,
	instanceId: string,
	cursor: string | null,
): string =>
	journalctl(
		profile,
		`-u ${unitName(instanceId)} --since ${JSON.stringify(journalSince(cursor))} -o short-iso --no-pager -n ${JOURNAL_MAX_LINES}`,
	)

export type InstanceReading = {
	changes: ConnectionChange[]
	cursor: string | null
}

export const readConnectionChanges = async (
	transport: Pick<HostTransport, "exec">,
	profile: HostProfile,
	instanceId: string,
	current: ConnectionCurrent,
	cursor: string | null,
): Promise<InstanceReading> => {
	const result = await transport.exec(
		journalCommand(profile, instanceId, cursor),
		JOURNAL_READ_TIMEOUT_MS,
	)
	if (result.exitCode !== 0) return { changes: [], cursor }

	const lines = parseJournal(result.stdout)
	const changes = changesFromSignals(current, connectionSignals(lines))
	const last = lines.at(-1)
	return {
		changes,
		cursor: last === undefined ? cursor : last.at.toISOString(),
	}
}

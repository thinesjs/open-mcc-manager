import { connectionSignals, parseJournal } from "@open-mcc/contracts/boundary/journal"
import type { HostTransport } from "@open-mcc/transport"
import { journalctl } from "../host/profile"
import { unitName } from "../instance/unit"
import { type ConnectionChange, type ConnectionCurrent, changesFromSignals } from "./connection"

export const JOURNAL_READ_TIMEOUT_MS = 20_000

export const JOURNAL_MAX_LINES = 2_000

export const SEED_WINDOW = "-7d"

export const journalTimestamp = (iso: string): string => {
	const at = new Date(iso)
	if (Number.isNaN(at.getTime())) return SEED_WINDOW
	return at.toISOString().slice(0, 19).replace("T", " ")
}

export const journalSince = (cursor: string | null): string =>
	cursor === null ? SEED_WINDOW : journalTimestamp(cursor)

export const journalCommand = (instanceId: string, cursor: string | null): string =>
	journalctl(
		`-u ${unitName(instanceId)} --since ${JSON.stringify(journalSince(cursor))} --utc -o short-iso --no-pager -n ${JOURNAL_MAX_LINES}`,
	)

export type InstanceReading = {
	changes: ConnectionChange[]
	cursor: string | null
}

export const readConnectionChanges = async (
	transport: Pick<HostTransport, "exec">,
	instanceId: string,
	current: ConnectionCurrent,
	cursor: string | null,
): Promise<InstanceReading> => {
	const result = await transport.exec(journalCommand(instanceId, cursor), JOURNAL_READ_TIMEOUT_MS)
	if (result.exitCode !== 0) return { changes: [], cursor }

	const lines = parseJournal(result.stdout)
	const signals = connectionSignals(lines)
	const last = lines.at(-1)
	const nextCursor = last === undefined ? cursor : last.at.toISOString()

	if (cursor === null) {
		const latest = signals.at(-1)
		if (latest === undefined) return { changes: [], cursor: nextCursor }
		return {
			changes: [
				latest.kind === "joined"
					? {
							state: "joined",
							at: latest.at,
							pid: latest.pid,
							event: "instance.joined",
							reason: undefined,
						}
					: latest.kind === "stopped"
						? {
								state: "down",
								at: latest.at,
								pid: latest.pid,
								event: "instance.stopped",
								reason: undefined,
							}
						: {
								state: "interrupted",
								at: latest.at,
								pid: latest.pid,
								event: "instance.connection_lost",
								reason: latest.reason,
							},
			],
			cursor: nextCursor,
		}
	}

	return { changes: changesFromSignals(current, signals), cursor: nextCursor }
}

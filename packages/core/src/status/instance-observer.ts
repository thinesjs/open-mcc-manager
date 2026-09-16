import { connectionSignals, parseJournal } from "@open-mcc/contracts/boundary/journal"
import { asReadCommand, type HostReader } from "@open-mcc/transport"
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

export const journalCommand = (instanceId: string, cursor: string | null): string => {
	const window = `-u ${unitName(instanceId)} --since ${JSON.stringify(journalSince(cursor))} --utc -o short-iso --no-pager`
	if (cursor === null) return journalctl(`${window} -n ${JOURNAL_MAX_LINES}`)
	return `{ ${journalctl(window)} || true; } | head -n ${JOURNAL_MAX_LINES}`
}

export const journalLineCount = (raw: string): number => {
	const parts = raw.split("\n")
	return parts.at(-1) === "" ? parts.length - 1 : parts.length
}

export type InstanceReading = {
	changes: ConnectionChange[]
	cursor: string | null
	full: boolean
}

export const readConnectionChanges = async (
	reader: Pick<HostReader, "exec">,
	instanceId: string,
	current: ConnectionCurrent,
	cursor: string | null,
): Promise<InstanceReading> => {
	const result = await reader.exec(asReadCommand(journalCommand(instanceId, cursor)))
	if (result.exitCode !== 0) return { changes: [], cursor, full: false }

	const full = cursor !== null && journalLineCount(result.stdout) >= JOURNAL_MAX_LINES
	const lines = parseJournal(result.stdout)
	const signals = connectionSignals(lines)
	const last = lines.at(-1)
	const nextCursor = last === undefined ? cursor : last.at.toISOString()

	if (cursor === null) {
		const latest = signals.at(-1)
		if (latest === undefined) return { changes: [], cursor: nextCursor, full }
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
			full,
		}
	}

	return { changes: changesFromSignals(current, signals), cursor: nextCursor, full }
}

export const JOURNAL_DRAIN_ROUNDS = 4

export type JournalLease = Pick<HostReader, "exec" | "release">

export type JournalDrain = {
	lease: () => Promise<JournalLease | undefined>
	record: (changes: ConnectionChange[]) => Promise<void>
	saveCursor: (cursor: string) => Promise<void>
}

export type DrainOutcome = "drained" | "unleased"

const connectionAfter = (
	current: ConnectionCurrent,
	changes: readonly ConnectionChange[],
): ConnectionCurrent => {
	const last = changes.at(-1)
	if (last === undefined) return current
	return { state: last.state, since: last.at, pid: last.pid }
}

export const drainConnectionChanges = async (
	drain: JournalDrain,
	instanceId: string,
	current: ConnectionCurrent,
	cursor: string | null,
): Promise<DrainOutcome> => {
	let seen = current
	let at = cursor

	for (let round = 0; round < JOURNAL_DRAIN_ROUNDS; round += 1) {
		const leased = await drain.lease()
		if (leased === undefined) return "unleased"

		let reading: InstanceReading
		try {
			reading = await readConnectionChanges(leased, instanceId, seen, at)
		} finally {
			leased.release()
		}

		await drain.record(reading.changes)

		const next = reading.cursor
		if (next === null || next === at) return "drained"
		await drain.saveCursor(next)
		if (!reading.full) return "drained"

		seen = connectionAfter(seen, reading.changes)
		at = next
	}

	return "drained"
}

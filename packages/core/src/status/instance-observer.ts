import {
	connectionSignals,
	isJournalCursor,
	journalBatch,
	journalRefusedCursor,
	parseJournal,
} from "@open-mcc/contracts/boundary/journal"
import type { InstanceRow } from "@open-mcc/db"
import { asReadCommand, type HostReader } from "@open-mcc/transport"
import { journalctl } from "../host/profile"
import { unitName } from "../instance/unit"
import { type ConnectionChange, type ConnectionCurrent, changesFromSignals } from "./connection"

export const JOURNAL_READ_TIMEOUT_MS = 20_000

export const JOURNAL_MAX_LINES = 2_000

export const JOURNAL_LINE_COLUMNS = 130

export const SEED_WINDOW = "-7d"

export const journalResume = (cursor: string | null): string | null =>
	cursor !== null && isJournalCursor(cursor) ? cursor : null

const widthOf = (command: string): string => `COLUMNS=${JOURNAL_LINE_COLUMNS} ${command}`

export const journalCommand = (instanceId: string, cursor: string | null): string => {
	const resume = journalResume(cursor)
	const read = `-u ${unitName(instanceId)} --utc -o short-iso --no-pager --no-full --show-cursor`
	if (resume === null) {
		return widthOf(
			journalctl(`${read} --since ${JSON.stringify(SEED_WINDOW)} -n ${JOURNAL_MAX_LINES}`),
		)
	}
	return widthOf(
		journalctl(`${read} --cursor ${JSON.stringify(resume)} -n ${JOURNAL_MAX_LINES + 1}`),
	)
}

export type InstanceReading = {
	changes: ConnectionChange[]
	cursor: string | null
	full: boolean
	refused: boolean
}

export const readConnectionChanges = async (
	reader: Pick<HostReader, "exec">,
	instanceId: string,
	current: ConnectionCurrent,
	cursor: string | null,
): Promise<InstanceReading> => {
	const resume = journalResume(cursor)
	const result = await reader.exec(asReadCommand(journalCommand(instanceId, cursor)))
	if (result.exitCode !== 0) {
		return {
			changes: [],
			cursor,
			full: false,
			refused: resume !== null && journalRefusedCursor(result.stderr),
		}
	}

	const batch = journalBatch(result.stdout)
	const full = resume !== null && batch.lines.length > JOURNAL_MAX_LINES
	const sighted = connectionSignals(parseJournal(batch.lines.join("\n")))
	const beyond = connectionSignals(
		parseJournal(full ? batch.lines.slice(-1).join("\n") : ""),
	).length
	const signals = sighted.slice(0, sighted.length - beyond)
	const next = batch.cursor ?? cursor

	if (resume === null) {
		const latest = signals.at(-1)
		if (latest === undefined) return { changes: [], cursor: next, full, refused: false }
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
			cursor: next,
			full,
			refused: false,
		}
	}

	return { changes: changesFromSignals(current, signals), cursor: next, full, refused: false }
}

export const JOURNAL_DRAIN_ROUNDS = 4

export type JournalLease = Pick<HostReader, "exec" | "release">

export type JournalDrain = {
	lease: () => Promise<JournalLease | undefined>
	record: (changes: ConnectionChange[]) => Promise<void>
	saveCursor: (cursor: string) => Promise<void>
	onRefused: (cursor: string) => void
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

		if (reading.refused && at !== null) {
			drain.onRefused(at)
			at = null
			continue
		}

		const next = reading.cursor
		if (next === null) return "drained"
		if (!reading.full) {
			if (next !== at) await drain.saveCursor(next)
			return "drained"
		}

		await drain.saveCursor(next)
		seen = connectionAfter(seen, reading.changes)
		at = next
	}

	return "drained"
}

export type InstanceSweep = {
	observe: (instance: InstanceRow) => Promise<DrainOutcome>
	onFailed: (instance: InstanceRow, error: Error | string) => void
}

export const observeEachInstance = async (
	instances: readonly InstanceRow[],
	sweep: InstanceSweep,
): Promise<void> => {
	for (const instance of instances) {
		try {
			if ((await sweep.observe(instance)) === "unleased") return
		} catch (error) {
			sweep.onFailed(instance, error instanceof Error ? error : String(error))
		}
	}
}

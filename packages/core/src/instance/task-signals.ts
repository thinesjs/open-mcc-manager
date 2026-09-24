import {
	connectionSignals,
	journalBatch,
	journalRefusedCursor,
	parseJournal,
} from "@open-mcc/contracts/boundary/journal"
import type { McpEventPage } from "@open-mcc/contracts/boundary/mcp"
import { asReadCommand, type HostReader } from "@open-mcc/transport"
import { JOURNAL_MAX_LINES, journalCommand, journalResume } from "../status/instance-observer"
import { type LiveReadTarget, readRecentEvents } from "./live-control"

export const JOIN_DRAIN_ROUNDS = 4

export const RESPAWN_EVENT_TYPE = "respawn"

export const RESPAWN_PAGE_MAX = 200

export type JoinSighting = {
	process: string
	occurredAt: Date
}

export type JoinReading = {
	joins: JoinSighting[]
	cursor: string | null
	seeded: boolean
	refused: boolean
	full: boolean
}

export const readJoinSightings = async (
	reader: Pick<HostReader, "exec">,
	instanceId: string,
	cursor: string | null,
): Promise<JoinReading> => {
	const resume = journalResume(cursor)
	const result = await reader.exec(asReadCommand(journalCommand(instanceId, cursor)))
	if (result.exitCode !== 0) {
		return {
			joins: [],
			cursor,
			seeded: false,
			refused: resume !== null && journalRefusedCursor(result.stderr),
			full: false,
		}
	}

	const batch = journalBatch(result.stdout)
	const next = batch.cursor ?? cursor
	if (resume === null) return { joins: [], cursor: next, seeded: true, refused: false, full: false }

	const joins = connectionSignals(parseJournal(batch.lines.join("\n")))
		.filter((signal) => signal.kind === "joined")
		.map((signal) => ({ process: signal.pid, occurredAt: signal.at }))

	return {
		joins,
		cursor: next,
		seeded: false,
		refused: false,
		full: batch.lines.length > JOURNAL_MAX_LINES,
	}
}

export type JoinDrain = {
	read: (cursor: string | null) => Promise<JoinReading>
	record: (joins: readonly JoinSighting[]) => Promise<void>
	saveCursor: (cursor: string) => Promise<void>
}

export const drainJoinSightings = async (
	drain: JoinDrain,
	cursor: string | null,
): Promise<void> => {
	let at = cursor

	for (let round = 0; round < JOIN_DRAIN_ROUNDS; round += 1) {
		const reading = await drain.read(at)
		await drain.record(reading.joins)

		if (reading.refused && at !== null) {
			at = null
			continue
		}

		const next = reading.cursor
		if (next === null) return
		if (next !== at) await drain.saveCursor(next)
		if (!reading.full) return
		at = next
	}
}

export type RespawnSighting = {
	eventId: number
	occurredAt: Date
}

export type RespawnReading = {
	respawns: RespawnSighting[]
	cursor: number
	seeded: boolean
}

export const respawnsFrom = (
	page: McpEventPage,
	cursor: number | null,
	at: Date,
): RespawnReading => {
	const afterId = cursor ?? 0
	const highest = page.events.reduce((seen, event) => Math.max(seen, event.id), page.latestId)
	const next = Math.max(afterId, highest)
	if (cursor === null) return { respawns: [], cursor: next, seeded: true }

	const respawns = page.events
		.filter((event) => event.type === RESPAWN_EVENT_TYPE && event.id > afterId)
		.map((event) => ({ eventId: event.id, occurredAt: momentOf(event.timestampUtc, at) }))

	return { respawns, cursor: next, seeded: false }
}

export const readRespawnSightings = async (
	target: LiveReadTarget,
	cursor: number | null,
	at: Date,
): Promise<RespawnReading> =>
	respawnsFrom(await readRecentEvents(target, cursor ?? 0, RESPAWN_PAGE_MAX), cursor, at)

const momentOf = (stamp: string, fallback: Date): Date => {
	const moment = new Date(stamp)
	return Number.isNaN(moment.getTime()) ? fallback : moment
}

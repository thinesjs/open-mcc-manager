export type JournalLine = {
	at: Date
	pid: string
	message: string
}

const LINE = /^(\S+)\s+\S+\s+[^[\]]*\[(\d+)\]:\s?(.*)$/

const COLOUR = /§./g

export const stripColour = (value: string): string => value.replace(COLOUR, "")

export const parseJournalLine = (raw: string): JournalLine | undefined => {
	const match = LINE.exec(raw)
	if (!match) return undefined
	const [, stamp, pid, rest] = match
	if (stamp === undefined || pid === undefined || rest === undefined) return undefined
	const at = new Date(stamp)
	if (Number.isNaN(at.getTime())) return undefined
	return { at, pid, message: stripColour(rest).trim() }
}

export const parseJournal = (raw: string): JournalLine[] => {
	const lines: JournalLine[] = []
	for (const candidate of raw.split("\n")) {
		if (candidate.trim().length === 0) continue
		const parsed = parseJournalLine(candidate)
		if (parsed !== undefined) lines.push(parsed)
	}
	return lines
}

const JOURNAL_CURSOR =
	/^s=[0-9a-f]{32};i=[0-9a-f]+;b=[0-9a-f]{32};m=[0-9a-f]+;t=[0-9a-f]+;x=[0-9a-f]+$/

export const isJournalCursor = (value: string): boolean => JOURNAL_CURSOR.test(value)

const NOTE = "-- "

const CURSOR_NOTE = "-- cursor: "

export type JournalBatch = {
	lines: string[]
	cursor: string | undefined
}

export const journalBatch = (raw: string): JournalBatch => {
	const lines: string[] = []
	let cursor: string | undefined
	for (const candidate of raw.split("\n")) {
		if (candidate.trim().length === 0) continue
		if (candidate.startsWith(CURSOR_NOTE)) {
			const shown = candidate.slice(CURSOR_NOTE.length).trim()
			cursor = isJournalCursor(shown) ? shown : undefined
			continue
		}
		if (candidate.startsWith(NOTE)) continue
		lines.push(candidate)
	}
	return { lines, cursor }
}

const CURSOR_REFUSED = "Failed to seek to cursor"

export const journalRefusedCursor = (stderr: string): boolean => stderr.includes(CURSOR_REFUSED)

export const JOINED_MARKER = "Server was successfully joined"

export const DISCONNECTED_MARKER = "Disconnected by Server"

export const STOPPED_MARKER = "Stopped open-mcc@"

export type ConnectionSignal =
	| { kind: "joined"; at: Date; pid: string }
	| { kind: "disconnected"; at: Date; pid: string; reason: string | undefined }
	| { kind: "stopped"; at: Date; pid: string }

const MCC_PREFIX = "[MCC]"

const withoutPrefix = (message: string): string =>
	message.startsWith(MCC_PREFIX) ? message.slice(MCC_PREFIX.length).trim() : message

export const connectionSignals = (lines: readonly JournalLine[]): ConnectionSignal[] => {
	const signals: ConnectionSignal[] = []
	lines.forEach((line, index) => {
		const message = withoutPrefix(line.message)
		if (message.includes(STOPPED_MARKER)) {
			signals.push({ kind: "stopped", at: line.at, pid: line.pid })
			return
		}
		if (message.includes(JOINED_MARKER)) {
			signals.push({ kind: "joined", at: line.at, pid: line.pid })
			return
		}
		if (!message.includes(DISCONNECTED_MARKER)) return
		const trailing = message.split(":").slice(1).join(":").trim()
		const next = lines[index + 1]
		const following =
			next === undefined || next.pid !== line.pid ? undefined : withoutPrefix(next.message)
		const reason = trailing.length > 0 ? trailing : following
		signals.push({
			kind: "disconnected",
			at: line.at,
			pid: line.pid,
			reason: reason === undefined || reason.length === 0 ? undefined : reason,
		})
	})
	return signals
}

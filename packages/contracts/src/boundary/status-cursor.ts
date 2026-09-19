export type StatusEventCursor = {
	readonly occurredAt: Date
	readonly id: string
}

const SEPARATOR = "|"

export const encodeStatusEventCursor = (cursor: StatusEventCursor): string =>
	`${cursor.occurredAt.toISOString()}${SEPARATOR}${cursor.id}`

export const parseStatusEventCursor = (raw: string): StatusEventCursor | undefined => {
	const at = raw.indexOf(SEPARATOR)
	if (at < 0) return undefined
	const stamp = raw.slice(0, at)
	const id = raw.slice(at + SEPARATOR.length)
	if (id.length === 0) return undefined
	const occurredAt = new Date(stamp)
	if (Number.isNaN(occurredAt.getTime())) return undefined
	if (occurredAt.toISOString() !== stamp) return undefined
	return { occurredAt, id }
}

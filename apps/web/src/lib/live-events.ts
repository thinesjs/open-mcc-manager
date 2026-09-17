export type LiveEvent = {
	id: number
	timestampUtc: string
	type: string
	subject?: string | undefined
}

const EVENT_LABEL: Record<string, string> = {
	player_join: "joined",
	player_leave: "left",
	death: "died",
	respawn: "respawned",
	disconnect: "disconnected",
}

export const describeLiveEvent = (event: LiveEvent): string => {
	const label = EVENT_LABEL[event.type] ?? event.type.replaceAll("_", " ")
	return event.subject === undefined ? label : `${event.subject} ${label}`
}

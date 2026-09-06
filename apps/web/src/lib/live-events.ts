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
	weather_rain: "rain changed",
	weather_thunder: "thunder changed",
}

export const describeLiveEvent = (event: LiveEvent): string => {
	const label = EVENT_LABEL[event.type] ?? event.type.replaceAll("_", " ")
	if (event.subject === undefined) return label
	return event.type.startsWith("weather_")
		? `${label} to ${event.subject}`
		: `${event.subject} ${label}`
}

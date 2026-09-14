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

const WEATHER_DECIMALS = 2

const weatherLevel = (subject: string): string => {
	const level = Number(subject)
	return Number.isFinite(level) ? `${Number(level.toFixed(WEATHER_DECIMALS))}` : subject
}

export const describeLiveEvent = (event: LiveEvent): string => {
	const label = EVENT_LABEL[event.type] ?? event.type.replaceAll("_", " ")
	if (event.subject === undefined) return label
	return event.type.startsWith("weather_")
		? `${label} to ${weatherLevel(event.subject)}`
		: `${event.subject} ${label}`
}

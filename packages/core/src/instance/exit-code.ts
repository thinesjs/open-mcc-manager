export type ExitMeaning = "clean" | "kicked" | "connection_lost" | "login_rejected" | "unknown"

export const interpretExitCode = (code: number): ExitMeaning => {
	if (code === 0) return "clean"
	if (code === 2) return "kicked"
	if (code === 3) return "connection_lost"
	if (code === 4) return "login_rejected"
	return "unknown"
}

export const shouldRestartOn = (meaning: ExitMeaning): boolean =>
	meaning === "kicked" || meaning === "connection_lost" || meaning === "unknown"

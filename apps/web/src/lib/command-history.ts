export const COMMAND_HISTORY_LIMIT = 8

export const rememberCommand = (
	history: readonly string[],
	command: string,
	limit: number = COMMAND_HISTORY_LIMIT,
): string[] => {
	const trimmed = command.trim()
	if (trimmed.length === 0) return [...history]
	return [trimmed, ...history.filter((entry) => entry !== trimmed)].slice(0, limit)
}

const storageKey = (instanceId: string): string => `open-mcc:command-history:${instanceId}`

const SEPARATOR = "\n"

export const readCommandHistory = (instanceId: string): string[] => {
	try {
		const raw = window.localStorage.getItem(storageKey(instanceId))
		if (raw === null || raw.length === 0) return []
		return raw.split(SEPARATOR).filter((entry) => entry.length > 0)
	} catch {
		return []
	}
}

export const writeCommandHistory = (instanceId: string, history: readonly string[]): void => {
	try {
		window.localStorage.setItem(storageKey(instanceId), history.join(SEPARATOR))
	} catch {
		return
	}
}

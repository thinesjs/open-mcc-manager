import { maskCommandCredentials, maskUnambiguousSecrets } from "@open-mcc/contracts"

export const COMMAND_HISTORY_LIMIT = 8

export const COMMAND_HISTORY_PREFIX = "open-mcc:command-history:"

const SEPARATOR = "\n"

const carriesSecret = (command: string): boolean =>
	maskCommandCredentials(command) !== command || maskUnambiguousSecrets(command) !== command

export const rememberCommand = (
	history: readonly string[],
	command: string,
	limit: number = COMMAND_HISTORY_LIMIT,
): string[] => {
	const trimmed = command.trim()
	if (trimmed.length === 0 || carriesSecret(trimmed)) return [...history]
	return [trimmed, ...history.filter((entry) => entry !== trimmed)].slice(0, limit)
}

const storageKey = (instanceId: string): string => `${COMMAND_HISTORY_PREFIX}${instanceId}`

const historyKeys = (storage: Storage): string[] => {
	const keys: string[] = []
	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index)
		if (key?.startsWith(COMMAND_HISTORY_PREFIX)) keys.push(key)
	}
	return keys
}

const purgeKey = (storage: Storage, key: string): string[] => {
	const raw = storage.getItem(key)
	if (raw === null || raw.length === 0) return []
	const stored = raw.split(SEPARATOR).filter((entry) => entry.length > 0)
	const kept = stored.filter((entry) => !carriesSecret(entry))
	if (kept.length !== stored.length) storage.setItem(key, kept.join(SEPARATOR))
	return kept
}

export const writeCommandHistory = (instanceId: string, history: readonly string[]): void => {
	try {
		window.localStorage.setItem(storageKey(instanceId), history.join(SEPARATOR))
	} catch {
		return
	}
}

export const readCommandHistory = (instanceId: string): string[] => {
	try {
		return purgeKey(window.localStorage, storageKey(instanceId))
	} catch {
		return []
	}
}

export const purgeCommandHistories = (): void => {
	try {
		const storage = window.localStorage
		for (const key of historyKeys(storage)) purgeKey(storage, key)
	} catch {
		return
	}
}

purgeCommandHistories()

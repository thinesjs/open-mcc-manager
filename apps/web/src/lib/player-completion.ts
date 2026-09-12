import { PLAYER_NAME_PATTERN } from "@open-mcc/contracts/boundary/mcp-readouts"

export const PLAYER_SUGGESTION_LIMIT = 6

export const PLAYER_TOKEN_MINIMUM = 2

const TRAILING_TOKEN = /\S*$/

const trailingToken = (draft: string): string => TRAILING_TOKEN.exec(draft)?.[0] ?? ""

export const suggestPlayers = (
	players: readonly string[],
	draft: string,
	limit: number = PLAYER_SUGGESTION_LIMIT,
): string[] => {
	const token = trailingToken(draft)
	if (token.length < PLAYER_TOKEN_MINIMUM) return []
	if (players.some((player) => !PLAYER_NAME_PATTERN.test(player))) return []

	const wanted = token.toLowerCase()
	const matched = new Set(players.filter((player) => player.toLowerCase().startsWith(wanted)))
	return [...matched].sort((left, right) => left.localeCompare(right)).slice(0, limit)
}

export const completeName = (
	draft: string,
	name: string,
	maxLength: number,
): string | undefined => {
	if (!PLAYER_NAME_PATTERN.test(name)) return undefined
	const kept = draft.slice(0, draft.length - trailingToken(draft).length)
	const completed = `${kept}${name}`
	return completed.length > maxLength ? undefined : completed
}

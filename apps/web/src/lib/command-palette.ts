export type PaletteItem = {
	id: string
	label: string
	group: string
	keywords?: string
}

const NO_MATCH = -1

export const initialsOf = (value: string): string =>
	value
		.toLowerCase()
		.split(/[\s\-_/.]+/)
		.filter((word) => word.length > 0)
		.map((word) => word.charAt(0))
		.join("")

export const subsequenceScore = (haystack: string, needle: string): number => {
	if (needle.length === 0) return 0
	const target = haystack.toLowerCase()
	const query = needle.toLowerCase()

	const exact = target.indexOf(query)
	if (exact === 0) return 1000
	if (exact > 0) return 800 - exact

	const initials = initialsOf(haystack)
	if (initials === query) return 900
	if (initials.startsWith(query)) return 850

	let score = 0
	let cursor = 0
	let previous = NO_MATCH
	for (const character of query) {
		const found = target.indexOf(character, cursor)
		if (found === NO_MATCH) return NO_MATCH
		score += found === previous + 1 ? 10 : 1
		previous = found
		cursor = found + 1
	}
	return score
}

export const rankPaletteItems = <T extends PaletteItem>(
	items: readonly T[],
	query: string,
): T[] => {
	const trimmed = query.trim()
	if (trimmed.length === 0) return [...items]

	return items
		.map((item) => ({
			item,
			score: Math.max(
				subsequenceScore(item.label, trimmed),
				item.keywords === undefined ? NO_MATCH : subsequenceScore(item.keywords, trimmed) - 1,
			),
		}))
		.filter((scored) => scored.score > NO_MATCH)
		.sort(
			(left, right) => right.score - left.score || left.item.label.localeCompare(right.item.label),
		)
		.map((scored) => scored.item)
}

export const groupPaletteItems = <T extends PaletteItem>(
	items: readonly T[],
): { group: string; items: T[] }[] => {
	const groups: { group: string; items: T[] }[] = []
	for (const item of items) {
		const existing = groups.find((entry) => entry.group === item.group)
		if (existing) {
			existing.items.push(item)
			continue
		}
		groups.push({ group: item.group, items: [item] })
	}
	return groups
}

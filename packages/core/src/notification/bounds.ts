const encoder = new TextEncoder()

const ELLIPSIS = "…"

export const byteLength = (text: string): number => encoder.encode(text).length

export const truncateChars = (text: string, max: number): string => {
	const points = Array.from(text)
	if (points.length <= max) return text
	if (max <= 1) return points.slice(0, max).join("")
	return `${points.slice(0, max - 1).join("")}${ELLIPSIS}`
}

export const truncateBytes = (text: string, max: number): string => {
	if (byteLength(text) <= max) return text
	const marker = byteLength(ELLIPSIS)
	const room = max > marker
	const budget = room ? max - marker : max
	let used = 0
	let kept = ""
	for (const point of text) {
		const size = byteLength(point)
		if (used + size > budget) break
		used += size
		kept += point
	}
	return room ? `${kept}${ELLIPSIS}` : kept
}

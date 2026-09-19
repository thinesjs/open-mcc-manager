const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined

export type LatestReleaseAnswer = {
	readonly tagName: string
	readonly body: string | null
}

export const parseLatestRelease = (raw: string): LatestReleaseAnswer | undefined => {
	let decoded: unknown
	try {
		decoded = JSON.parse(raw)
	} catch {
		return undefined
	}
	const release = asRecord(decoded)
	if (!release) return undefined
	const tagName = release.tag_name
	if (typeof tagName !== "string") return undefined
	const body = release.body
	if (body === undefined || body === null) return { tagName, body: null }
	if (typeof body !== "string") return undefined
	return { tagName, body }
}

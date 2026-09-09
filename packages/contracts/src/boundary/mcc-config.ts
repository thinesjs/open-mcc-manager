import { parse } from "smol-toml"

export type McConfigScalar = string | number | boolean

export type McConfigRange = { min: number; max: number }

export type McConfigValue = McConfigScalar | McConfigRange

export type McConfigReading = {
	values: Map<string, McConfigValue>
	unreadable: string[]
}

export class McConfigUnparseableError extends Error {}

const isScalar = (value: unknown): value is McConfigScalar =>
	typeof value === "string" || typeof value === "number" || typeof value === "boolean"

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const readRange = (value: Record<string, unknown>): McConfigValue | undefined => {
	const keys = Object.keys(value)
	if (keys.length !== 2 || !keys.includes("min") || !keys.includes("max")) return undefined
	const min = value.min
	const max = value.max
	if (typeof min !== "number" || typeof max !== "number") return undefined
	return min === max ? min : { min, max }
}

const descend = (root: Record<string, unknown>, path: readonly string[]): unknown => {
	let current: unknown = root
	for (const segment of path) {
		if (!isRecord(current)) return undefined
		current = current[segment]
	}
	return current
}

export const parseMccConfig = (text: string): Record<string, unknown> => {
	try {
		const document = parse(text, { integersAsBigInt: "asNeeded" })
		return isRecord(document) ? document : {}
	} catch (error) {
		throw new McConfigUnparseableError(
			error instanceof Error ? error.message : "The client config could not be read",
		)
	}
}

export const readMccConfigKeys = (text: string, keys: readonly string[]): McConfigReading => {
	const document = parseMccConfig(text)
	const values = new Map<string, McConfigValue>()
	const unreadable: string[] = []

	for (const key of keys) {
		const found = descend(document, key.split("."))
		if (found === undefined) continue
		if (isScalar(found)) {
			values.set(key, found)
			continue
		}
		if (isRecord(found)) {
			const collapsed = readRange(found)
			if (collapsed !== undefined) {
				values.set(key, collapsed)
				continue
			}
		}
		unreadable.push(key)
	}

	return { values, unreadable }
}

export const readMccConfigSections = (
	text: string,
	sections: readonly string[],
): Map<string, number> => {
	const document = parseMccConfig(text)
	const sizes = new Map<string, number>()
	for (const section of sections) {
		const found = descend(document, section.split("."))
		if (isRecord(found)) sizes.set(section, Object.keys(found).length)
	}
	return sizes
}

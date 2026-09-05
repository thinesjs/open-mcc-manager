import type { McConfigScalar } from "@open-mcc/contracts/boundary/mcc-config"
import { readMccConfigKeys, readMccConfigSections } from "@open-mcc/contracts/boundary/mcc-config"
import { ALLOWED_CONFIG_KEYS, EMPTIED_CONFIG_SECTIONS, FIXED_CONFIG_KEYS } from "./config"

export type ConfigDrift =
	| {
			kind: "managed" | "fixed"
			key: string
			expected: McConfigScalar
			actual: McConfigScalar | undefined
	  }
	| { kind: "section"; section: string; entries: number }
	| { kind: "unreadable"; key: string }

export const CONFIG_PATH_NAME = "MinecraftClient.ini"

const MANAGED_KEYS: readonly string[] = ALLOWED_CONFIG_KEYS
const FIXED_KEYS: readonly string[] = FIXED_CONFIG_KEYS
const ALL_KEYS: readonly string[] = [...ALLOWED_CONFIG_KEYS, ...FIXED_CONFIG_KEYS]

export const compareInstanceConfig = (
	expectedDocument: string,
	actualDocument: string,
): ConfigDrift[] => {
	const expected = readMccConfigKeys(expectedDocument, ALL_KEYS)
	const actual = readMccConfigKeys(actualDocument, ALL_KEYS)
	const drift: ConfigDrift[] = []

	for (const key of ALL_KEYS) {
		const want = expected.values.get(key)
		if (want === undefined) continue
		const have = actual.values.get(key)
		if (have === want) continue
		drift.push({
			kind: FIXED_KEYS.includes(key) ? "fixed" : "managed",
			key,
			expected: want,
			actual: have,
		})
	}

	for (const key of actual.unreadable) {
		if (!ALL_KEYS.includes(key)) continue
		if (drift.some((entry) => entry.kind !== "section" && entry.key === key)) continue
		drift.push({ kind: "unreadable", key })
	}

	const sections = readMccConfigSections(actualDocument, EMPTIED_CONFIG_SECTIONS)
	for (const section of EMPTIED_CONFIG_SECTIONS) {
		const entries = sections.get(section)
		if (entries !== undefined && entries > 0) drift.push({ kind: "section", section, entries })
	}

	return drift
}

export const describeConfigDrift = (drift: ConfigDrift): string => {
	if (drift.kind === "section") {
		return `${drift.section} should be empty but holds ${drift.entries} ${
			drift.entries === 1 ? "entry" : "entries"
		}`
	}
	if (drift.kind === "unreadable") {
		return `${drift.key} holds a value this manager cannot read`
	}
	const actual = drift.actual === undefined ? "nothing" : JSON.stringify(drift.actual)
	return `${drift.key} is ${actual}, expected ${JSON.stringify(drift.expected)}`
}

export const isSafetyDrift = (drift: ConfigDrift): boolean =>
	drift.kind === "fixed" || drift.kind === "section"

export { MANAGED_KEYS }

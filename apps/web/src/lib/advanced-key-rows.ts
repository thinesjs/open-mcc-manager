import {
	ADVANCED_KEY_SHAPE,
	type AdvancedKeyName,
	type AdvancedKeyRow,
	type AdvancedKeys,
	advancedKeysSchema,
} from "@open-mcc/contracts/boundary/mcc-config-keys"
import { z } from "zod"

export const ADVANCED_KEY_OPTIONS = z
	.object(ADVANCED_KEY_SHAPE)
	.keyof()
	.options.slice()
	.sort((left, right) => left.localeCompare(right))

export const advancedKeyRowsFrom = (keys: AdvancedKeys): readonly AdvancedKeyRow[] =>
	ADVANCED_KEY_OPTIONS.flatMap((name) => {
		const value = keys[name]
		return value === undefined ? [] : [{ key: name, value }]
	}).sort((left, right) => left.key.localeCompare(right.key))

export const advancedKeysFromRows = (rows: readonly AdvancedKeyRow[]): AdvancedKeys => {
	const carried: Record<string, string> = {}
	for (const row of rows) {
		if (row.key === null) continue
		carried[row.key] = row.value
	}
	return advancedKeysSchema.parse(carried)
}

const byKey = (given: readonly AdvancedKeyRow[]): readonly AdvancedKeyRow[] =>
	[...given].sort((left, right) => (left.key ?? "").localeCompare(right.key ?? ""))

export const sameAdvancedKeyRows = (
	left: readonly AdvancedKeyRow[],
	right: readonly AdvancedKeyRow[],
): boolean => {
	if (left.length !== right.length) return false
	const sortedLeft = byKey(left)
	const sortedRight = byKey(right)
	return sortedLeft.every((row, index) => {
		const other = sortedRight[index]
		return other !== undefined && row.key === other.key && row.value === other.value
	})
}

export const addAdvancedKeyRow = (rows: readonly AdvancedKeyRow[]): readonly AdvancedKeyRow[] => [
	...rows,
	{ key: null, value: "" },
]

export const editAdvancedKeyRow = (
	rows: readonly AdvancedKeyRow[],
	index: number,
	value: string,
): readonly AdvancedKeyRow[] =>
	rows.map((row, position) => (position === index ? { ...row, value } : row))

export const selectAdvancedKeyRow = (
	rows: readonly AdvancedKeyRow[],
	index: number,
	key: AdvancedKeyName,
): readonly AdvancedKeyRow[] =>
	rows.map((row, position) => (position === index ? { key, value: "" } : row))

export const removeAdvancedKeyRow = (
	rows: readonly AdvancedKeyRow[],
	index: number,
): readonly AdvancedKeyRow[] => rows.filter((_, position) => position !== index)

const COOLDOWN_CUSTOM = "ChatBot.AutoAttack.Cooldown_Time.Custom"
const COOLDOWN_MIN = "ChatBot.AutoAttack.Cooldown_Time.Min"
const COOLDOWN_MAX = "ChatBot.AutoAttack.Cooldown_Time.Max"
const COOLDOWN_DEFAULTS = { min: 1.5, max: 2.5 } as const

const withCooldownRules = (
	rows: readonly AdvancedKeyRow[],
	issues: readonly (string | null)[],
): readonly (string | null)[] => {
	const settledValueAt = (name: string): string | undefined =>
		rows.find((row, index) => row.key === name && issues[index] === null)?.value
	if (settledValueAt(COOLDOWN_CUSTOM) !== "true") return issues
	const savedMin = settledValueAt(COOLDOWN_MIN)
	const savedMax = settledValueAt(COOLDOWN_MAX)
	const min = savedMin === undefined ? COOLDOWN_DEFAULTS.min : Number(savedMin)
	const max = savedMax === undefined ? COOLDOWN_DEFAULTS.max : Number(savedMax)
	return rows.map((row, index) => {
		if (row.key === COOLDOWN_MIN && savedMin !== undefined) {
			if (min <= 0) return "More than 0"
			if (min > max) return `Above the maximum (${max})`
		}
		if (row.key === COOLDOWN_MAX && savedMax !== undefined) {
			if (max <= 0) return "More than 0"
			if (min > max) return `Below the minimum (${min})`
		}
		return issues[index] ?? null
	})
}

export const validateAdvancedKeyRows = (
	rows: readonly AdvancedKeyRow[],
): readonly (string | null)[] => {
	const occurrences = new Map<string, number>()
	for (const row of rows) {
		if (row.key === null) continue
		occurrences.set(row.key, (occurrences.get(row.key) ?? 0) + 1)
	}
	const issues = rows.map((row) => {
		if (row.key === null) return "Choose a key"
		if ((occurrences.get(row.key) ?? 0) > 1) return "Duplicate key"
		const result = ADVANCED_KEY_SHAPE[row.key].safeParse(row.value)
		return result.success ? null : result.error.issues.map((issue) => issue.message).join(" ")
	})
	return withCooldownRules(rows, issues)
}

import type { InstanceBotsInput, InstanceConfigInput } from "@open-mcc/contracts"
import {
	ADVANCED_KEY_SHAPE,
	advancedKeysSchema,
	BOT_CONFIG_SHAPE,
	botConfigSchema,
	SETTING_SHAPE,
	type SettingName,
} from "@open-mcc/contracts/boundary/mcc-config-keys"
import { z } from "zod"
import {
	BOT_CONFIG_DEPENDENCIES,
	BOT_CONFIG_FIELDS,
	type BotConfigDependency,
	INSTANCE_SETTING_LABELS,
} from "./bot-config-fields"

export type BotConfigValue = string | readonly string[]

export type BotConfigDraft = Readonly<Partial<Record<SettingName, BotConfigValue>>>

export type BotConfigIssues = Readonly<Partial<Record<SettingName, string>>>

const NAMES: readonly SettingName[] = z.object(SETTING_SHAPE).keyof().options

const BOT_NAMES: readonly SettingName[] = z.object(BOT_CONFIG_SHAPE).keyof().options

const KEY_NAMES: readonly SettingName[] = z.object(ADVANCED_KEY_SHAPE).keyof().options

const SCHEMAS = new Map(Object.entries(SETTING_SHAPE))

export const draftFrom = (bots: InstanceBotsInput): BotConfigDraft => {
	const saved = new Map<string, BotConfigValue | undefined>([
		...Object.entries(bots.botConfig),
		...Object.entries(bots.advancedKeys),
	])
	const draft: Partial<Record<SettingName, BotConfigValue>> = {}
	for (const name of NAMES) {
		const value = saved.get(name)
		if (value !== undefined) draft[name] = value
	}
	return draft
}

const COOLDOWN_CUSTOM = "ChatBot.AutoAttack.Cooldown_Time.Custom"
const COOLDOWN_MIN = "ChatBot.AutoAttack.Cooldown_Time.Min"
const COOLDOWN_MAX = "ChatBot.AutoAttack.Cooldown_Time.Max"

const clientNumber = (name: SettingName): number => {
	const fallback = BOT_CONFIG_FIELDS[name].clientDefault
	return typeof fallback === "string" ? Number(fallback) : Number.NaN
}

const withCooldownRules = (
	draft: BotConfigDraft,
	issues: Partial<Record<SettingName, string>>,
): Partial<Record<SettingName, string>> => {
	const settled = (name: SettingName): string | undefined => {
		const value = draft[name]
		return typeof value === "string" && issues[name] === undefined ? value : undefined
	}
	if (settled(COOLDOWN_CUSTOM) !== "true") return issues
	const savedMin = settled(COOLDOWN_MIN)
	const savedMax = settled(COOLDOWN_MAX)
	const min = savedMin === undefined ? clientNumber(COOLDOWN_MIN) : Number(savedMin)
	const max = savedMax === undefined ? clientNumber(COOLDOWN_MAX) : Number(savedMax)
	const ruled = { ...issues }
	if (savedMin !== undefined) {
		if (min <= 0) ruled[COOLDOWN_MIN] = "More than 0"
		else if (min > max) ruled[COOLDOWN_MIN] = `Above the maximum (${max})`
	}
	if (savedMax !== undefined) {
		if (max <= 0) ruled[COOLDOWN_MAX] = "More than 0"
		else if (min > max) ruled[COOLDOWN_MAX] = `Below the minimum (${min})`
	}
	return ruled
}

const withCrossKeyRules = (
	draft: BotConfigDraft,
	issues: Partial<Record<SettingName, string>>,
): Partial<Record<SettingName, string>> => {
	const result = botConfigSchema.safeParse(kept(draft, BOT_NAMES))
	if (result.success) return issues
	const ruled = { ...issues }
	for (const issue of result.error.issues) {
		const name = BOT_NAMES.find((each) => each === issue.path[0])
		if (name !== undefined && ruled[name] === undefined) ruled[name] = issue.message
	}
	return ruled
}

export const validateBotConfig = (draft: BotConfigDraft): BotConfigIssues => {
	const issues: Partial<Record<SettingName, string>> = {}
	for (const name of NAMES) {
		const value = draft[name]
		if (value === undefined) continue
		const schema = SCHEMAS.get(name)
		if (schema === undefined) continue
		const result = schema.safeParse(value)
		if (result.success) continue
		issues[name] = result.error.issues.map((issue) => issue.message).join(" ")
	}
	return withCrossKeyRules(draft, withCooldownRules(draft, issues))
}

const kept = (
	draft: BotConfigDraft,
	names: readonly SettingName[],
): Partial<Record<SettingName, BotConfigValue>> => {
	const held: Partial<Record<SettingName, BotConfigValue>> = {}
	for (const name of names) {
		const value = draft[name]
		if (value !== undefined) held[name] = value
	}
	return held
}

export const savedFrom = (draft: BotConfigDraft): InstanceBotsInput => ({
	botConfig: botConfigSchema.parse(kept(draft, BOT_NAMES)),
	advancedKeys: advancedKeysSchema.parse(kept(draft, KEY_NAMES)),
})

const sameValue = (left: BotConfigValue, right: BotConfigValue): boolean => {
	if (typeof left === "string" || typeof right === "string") return left === right
	return left.length === right.length && left.every((entry, index) => entry === right[index])
}

export const sameBotConfigDraft = (left: BotConfigDraft, right: BotConfigDraft): boolean =>
	NAMES.every((name) => {
		const ours = left[name]
		const theirs = right[name]
		if (ours === undefined || theirs === undefined) return ours === theirs
		return sameValue(ours, theirs)
	})

export const isStored = (draft: BotConfigDraft, key: SettingName): boolean =>
	Object.hasOwn(draft, key)

export const effectiveValue = (draft: BotConfigDraft, key: SettingName): BotConfigValue =>
	draft[key] ?? BOT_CONFIG_FIELDS[key].clientDefault

export const storeValue = (
	draft: BotConfigDraft,
	key: SettingName,
	value: BotConfigValue,
): BotConfigDraft => ({ ...draft, [key]: value })

export const clearValue = (draft: BotConfigDraft, key: SettingName): BotConfigDraft => {
	const next: Partial<Record<SettingName, BotConfigValue>> = { ...draft }
	delete next[key]
	return next
}

export type UnmetDependency = { readonly requires: readonly string[] }

const dependencyFor = (key: SettingName): BotConfigDependency | undefined =>
	BOT_CONFIG_DEPENDENCIES.find((entry) => entry.keys.includes(key))

export const unmetDependency = (
	draft: BotConfigDraft,
	instance: InstanceConfigInput,
	key: SettingName,
): UnmetDependency | undefined => {
	let current = key
	for (let step = 0; step <= BOT_CONFIG_DEPENDENCIES.length; step += 1) {
		const dependency = dependencyFor(current)
		if (dependency === undefined) return undefined
		if (dependency.kind === "instance") {
			const missing = dependency.requires.filter((setting) => instance[setting] !== true)
			if (missing.length === 0) return undefined
			return { requires: missing.map((setting) => INSTANCE_SETTING_LABELS[setting]) }
		}
		if (effectiveValue(draft, dependency.requires) !== "true") {
			return { requires: [BOT_CONFIG_FIELDS[dependency.requires].label] }
		}
		current = dependency.requires
	}
	return undefined
}

export const describeUnmetDependency = ({ requires }: UnmetDependency): string =>
	requires.length === 1
		? `Does nothing until ${requires[0]} is on.`
		: `Does nothing until these are on: ${requires.join(", ")}.`

import type { InstanceConfigInput } from "@open-mcc/contracts"
import {
	BOT_CONFIG_SHAPE,
	type BotConfig,
	type BotConfigName,
	botConfigSchema,
} from "@open-mcc/contracts/boundary/mcc-config-keys"
import { z } from "zod"
import {
	BOT_CONFIG_DEPENDENCIES,
	BOT_CONFIG_FIELDS,
	type BotConfigDependency,
	INSTANCE_SETTING_LABELS,
} from "./bot-config-fields"

export type BotConfigValue = string | readonly string[]

export type BotConfigDraft = Readonly<Partial<Record<BotConfigName, BotConfigValue>>>

export type BotConfigIssues = Readonly<Partial<Record<BotConfigName, string>>>

const NAMES: readonly BotConfigName[] = z.object(BOT_CONFIG_SHAPE).keyof().options

const SCHEMAS = new Map(Object.entries(BOT_CONFIG_SHAPE))

export const draftFrom = (botConfig: BotConfig): BotConfigDraft => {
	const saved: Partial<BotConfig> = botConfig ?? {}
	const draft: Partial<Record<BotConfigName, BotConfigValue>> = {}
	for (const name of NAMES) {
		const value = saved[name]
		if (value !== undefined) draft[name] = value
	}
	return draft
}

export const validateBotConfig = (draft: BotConfigDraft): BotConfigIssues => {
	const issues: Partial<Record<BotConfigName, string>> = {}
	for (const name of NAMES) {
		const value = draft[name]
		if (value === undefined) continue
		const schema = SCHEMAS.get(name)
		if (schema === undefined) continue
		const result = schema.safeParse(value)
		if (result.success) continue
		issues[name] = result.error.issues.map((issue) => issue.message).join(" ")
	}
	return issues
}

export const savedFrom = (draft: BotConfigDraft): BotConfig => botConfigSchema.parse(draft)

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

export const isStored = (draft: BotConfigDraft, key: BotConfigName): boolean =>
	Object.hasOwn(draft, key)

export const effectiveValue = (draft: BotConfigDraft, key: BotConfigName): BotConfigValue =>
	draft[key] ?? BOT_CONFIG_FIELDS[key].clientDefault

export const storeValue = (
	draft: BotConfigDraft,
	key: BotConfigName,
	value: BotConfigValue,
): BotConfigDraft => ({ ...draft, [key]: value })

export const clearValue = (draft: BotConfigDraft, key: BotConfigName): BotConfigDraft => {
	const next: Partial<Record<BotConfigName, BotConfigValue>> = { ...draft }
	delete next[key]
	return next
}

export type UnmetDependency = { readonly requires: string }

const dependencyFor = (key: BotConfigName): BotConfigDependency | undefined =>
	BOT_CONFIG_DEPENDENCIES.find((entry) => entry.keys.includes(key))

export const unmetDependency = (
	draft: BotConfigDraft,
	instance: InstanceConfigInput,
	key: BotConfigName,
): UnmetDependency | undefined => {
	let current = key
	for (let step = 0; step <= BOT_CONFIG_DEPENDENCIES.length; step += 1) {
		const dependency = dependencyFor(current)
		if (dependency === undefined) return undefined
		if (dependency.kind === "instance") {
			const missing = dependency.requires.filter((setting) => instance[setting] !== true)
			if (missing.length === 0) return undefined
			return {
				requires: missing.map((setting) => INSTANCE_SETTING_LABELS[setting]).join(" and "),
			}
		}
		if (effectiveValue(draft, dependency.requires) !== "true") {
			return { requires: BOT_CONFIG_FIELDS[dependency.requires].label }
		}
		current = dependency.requires
	}
	return undefined
}

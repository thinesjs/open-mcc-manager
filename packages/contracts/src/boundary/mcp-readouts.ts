import { z } from "zod"
import { type JsonRpcResponse, McpProtocolError, toolResultOf } from "./mcp"

export const EFFECT_IDS = [
	"Speed",
	"Slowness",
	"Haste",
	"MiningFatigue",
	"Strength",
	"InstantHealth",
	"InstantDamage",
	"JumpBoost",
	"Nausea",
	"Regeneration",
	"Resistance",
	"FireResistance",
	"WaterBreathing",
	"Invisibility",
	"Blindness",
	"NightVision",
	"Hunger",
	"Weakness",
	"Poison",
	"Wither",
	"HealthBoost",
	"Absorption",
	"Saturation",
	"Glowing",
	"Levitation",
	"Luck",
	"BadLuck",
	"SlowFalling",
	"ConduitPower",
	"DolphinsGrace",
	"BadOmen",
	"HerooftheVillage",
] as const

export const HEALTH_MAXIMUM = 1024
export const FOOD_LEVEL_MAXIMUM = 255
export const LEVEL_MAXIMUM = 1000000
export const TOTAL_EXPERIENCE_MAXIMUM = 2147483647
export const GAMEMODE_MAXIMUM = 3
export const HOTBAR_SLOTS = 9
export const PITCH_LIMIT = 90
export const TPS_MAXIMUM = 20
export const AMPLIFIER_MAXIMUM = 255
export const INFINITE_EFFECT_SECONDS = -1
export const REMAINING_SECONDS_MAXIMUM = 107374182
export const EFFECTS_MAXIMUM = 32
export const BOTS_MAXIMUM = 64
export const PLAYERS_MAXIMUM = 1000

const rawPlayerStats = z.object({
	health: z.number().min(0).max(HEALTH_MAXIMUM),
	saturation: z.number().int().min(0).max(FOOD_LEVEL_MAXIMUM),
	level: z.number().int().min(0).max(LEVEL_MAXIMUM),
	totalExperience: z.number().int().min(0).max(TOTAL_EXPERIENCE_MAXIMUM),
	gamemode: z.number().int().min(0).max(GAMEMODE_MAXIMUM),
	currentSlot: z.number().int().min(1).max(HOTBAR_SLOTS),
	yaw: z.number().finite(),
	pitch: z.number().min(-PITCH_LIMIT).max(PITCH_LIMIT),
	tps: z.number().gt(0).max(TPS_MAXIMUM),
})

const normalisedPlayerStats = rawPlayerStats.transform((value) => ({
	health: value.health,
	foodLevel: value.saturation,
	level: value.level,
	totalExperience: value.totalExperience,
	gamemode: value.gamemode,
	currentSlot: value.currentSlot,
	yaw: value.yaw,
	pitch: value.pitch,
	tps: value.tps,
}))

export type McpPlayerStats = z.infer<typeof normalisedPlayerStats>

const remainingSeconds = z.union([
	z.literal(INFINITE_EFFECT_SECONDS),
	z.number().int().min(0).max(REMAINING_SECONDS_MAXIMUM),
])

const rawStatusEffect = z
	.object({
		id: z.enum(EFFECT_IDS),
		amplifier: z.number().int().min(0).max(AMPLIFIER_MAXIMUM),
		remainingSeconds,
		isInfinite: z.boolean(),
	})
	.refine((value) => value.isInfinite === (value.remainingSeconds === INFINITE_EFFECT_SECONDS), {
		message: "The client reported an effect whose infinite flag and remaining time disagree",
	})

const rawStatusEffects = z
	.object({
		count: z.number(),
		effects: z.array(rawStatusEffect).max(EFFECTS_MAXIMUM),
	})
	.refine((value) => value.count === value.effects.length, {
		message: "The client reported a count that does not match the effects it sent",
	})

export type McpStatusEffect = z.infer<typeof rawStatusEffect>

export const BOT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

const rawLoadedBot = z.object({
	name: z.string().regex(BOT_NAME_PATTERN),
	isScript: z.boolean(),
})

const rawLoadedBots = z
	.object({
		count: z.number(),
		bots: z.array(rawLoadedBot).max(BOTS_MAXIMUM),
	})
	.refine((value) => value.count === value.bots.length, {
		message: "The client reported a count that does not match the bots it sent",
	})

export type McpLoadedBot = z.infer<typeof rawLoadedBot>

export const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/

const rawPlayersList = z.object({
	players: z.array(z.string().regex(PLAYER_NAME_PATTERN)).max(PLAYERS_MAXIMUM),
})

const unreadable = (what: string): McpProtocolError =>
	new McpProtocolError(`The client reported ${what} this manager cannot read`)

export const playerStatsFrom = (response: JsonRpcResponse): McpPlayerStats => {
	const parsed = normalisedPlayerStats.safeParse(toolResultOf(response))
	if (!parsed.success) throw unreadable("player stats")
	return parsed.data
}

export const statusEffectsFrom = (response: JsonRpcResponse): McpStatusEffect[] => {
	const parsed = rawStatusEffects.safeParse(toolResultOf(response))
	if (!parsed.success) throw unreadable("status effects")
	return parsed.data.effects.map((effect) => ({
		id: effect.id,
		amplifier: effect.amplifier,
		remainingSeconds: effect.remainingSeconds,
		isInfinite: effect.isInfinite,
	}))
}

export const loadedBotsFrom = (response: JsonRpcResponse): McpLoadedBot[] => {
	const parsed = rawLoadedBots.safeParse(toolResultOf(response))
	if (!parsed.success) throw unreadable("loaded bots")
	return parsed.data.bots.map((bot) => ({ name: bot.name, isScript: bot.isScript }))
}

export const playersListFrom = (response: JsonRpcResponse): string[] => {
	const parsed = rawPlayersList.safeParse(toolResultOf(response))
	if (!parsed.success) throw unreadable("a players list")
	return parsed.data.players
}

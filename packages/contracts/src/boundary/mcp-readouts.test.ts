import { describe, expect, it } from "vitest"
import { type JsonRpcResponse, McpProtocolError, responseFrom } from "./mcp"
import {
	EFFECT_IDS,
	loadedBotsFrom,
	playerStatsFrom,
	playersListFrom,
	statusEffectsFrom,
} from "./mcp-readouts"

const direct = (payload: unknown): JsonRpcResponse => ({
	jsonrpc: "2.0",
	id: 1,
	result: { structuredContent: { success: true, data: payload }, content: [] },
})

const reply = (payload: unknown) =>
	responseFrom(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: { structuredContent: { success: true, data: payload }, content: [] },
		}),
	)

const VALID_STATS: Record<string, unknown> = {
	username: "AfkBot",
	playerEntityId: 4242,
	location: { x: 1, y: 2, z: 3 },
	health: 18.5,
	saturation: 17,
	level: 30,
	totalExperience: 1395,
	gamemode: 0,
	currentSlot: 1,
	yaw: -134.25,
	pitch: 12.5,
	tps: 19.87,
}

const statsWith = (overrides: Record<string, unknown>): Record<string, unknown> => ({
	...VALID_STATS,
	...overrides,
})

const statsWithout = (key: string): Record<string, unknown> => {
	const payload = { ...VALID_STATS }
	delete payload[key]
	return payload
}

const RETAINED_STATS = [
	"health",
	"saturation",
	"level",
	"totalExperience",
	"gamemode",
	"currentSlot",
	"yaw",
	"pitch",
	"tps",
] as const

describe("reading the player stats readout", () => {
	it("keeps exactly the nine retained fields and drops the other three", () => {
		expect(playerStatsFrom(reply(VALID_STATS))).toEqual({
			health: 18.5,
			foodLevel: 17,
			level: 30,
			totalExperience: 1395,
			gamemode: 0,
			currentSlot: 1,
			yaw: -134.25,
			pitch: 12.5,
			tps: 19.87,
		})
	})

	it("reports the food level under a name that says what it is", () => {
		const stats = playerStatsFrom(reply(statsWith({ saturation: 3 })))

		expect(stats.foodLevel).toBe(3)
		expect(Object.keys(stats)).not.toContain("saturation")
	})

	it("accepts slot 1, which is what the client sends for the first hotbar slot", () => {
		expect(playerStatsFrom(reply(statsWith({ currentSlot: 1 }))).currentSlot).toBe(1)
	})

	it.each([
		{ named: "a fractional food level", overrides: { saturation: 17.5 } },
		{ named: "a fractional level", overrides: { level: 30.5 } },
		{ named: "a fractional total experience", overrides: { totalExperience: 1395.5 } },
		{ named: "a fractional gamemode", overrides: { gamemode: 0.5 } },
		{ named: "a fractional hotbar slot", overrides: { currentSlot: 1.5 } },
	])("refuses $named", ({ overrides }) => {
		expect(() => playerStatsFrom(reply(statsWith(overrides)))).toThrow(McpProtocolError)
	})

	it.each([
		{ named: "an infinity", value: Number.POSITIVE_INFINITY },
		{ named: "a negative infinity", value: Number.NEGATIVE_INFINITY },
		{ named: "a not-a-number", value: Number.NaN },
	])("never sees $named over the wire, which turns it into null", ({ value }) => {
		expect(JSON.parse(JSON.stringify({ yaw: value })).yaw).toBeNull()
		expect(() => playerStatsFrom(reply(statsWith({ yaw: value })))).toThrow(McpProtocolError)
	})

	it.each([
		{ named: "an infinite yaw", value: Number.POSITIVE_INFINITY },
		{ named: "a negatively infinite yaw", value: Number.NEGATIVE_INFINITY },
	])("refuses $named handed straight to it, the one float no bound rules out", ({ value }) => {
		expect(() => playerStatsFrom(direct(statsWith({ yaw: value })))).toThrow(McpProtocolError)
	})

	it.each(RETAINED_STATS)("refuses a stringly %s that would coerce to a valid number", (field) => {
		expect(() => playerStatsFrom(reply(statsWith({ [field]: "1" })))).toThrow(McpProtocolError)
	})

	it.each(RETAINED_STATS)("refuses a null %s", (field) => {
		expect(() => playerStatsFrom(reply(statsWith({ [field]: null })))).toThrow(McpProtocolError)
	})

	it.each(RETAINED_STATS)("refuses a payload with %s missing", (field) => {
		expect(() => playerStatsFrom(reply(statsWithout(field)))).toThrow(McpProtocolError)
	})

	it.each([
		{ named: "health below zero", overrides: { health: -1 } },
		{ named: "health above the cap", overrides: { health: 1025 } },
		{ named: "a food level below zero", overrides: { saturation: -1 } },
		{ named: "a food level above the cap", overrides: { saturation: 256 } },
		{ named: "a level below zero", overrides: { level: -1 } },
		{ named: "a level above the cap", overrides: { level: 1000001 } },
		{ named: "total experience below zero", overrides: { totalExperience: -1 } },
		{ named: "total experience above a C# int", overrides: { totalExperience: 2147483648 } },
		{ named: "a gamemode below zero", overrides: { gamemode: -1 } },
		{ named: "a gamemode past the four the game has", overrides: { gamemode: 4 } },
		{ named: "hotbar slot zero, which one-basing rules out", overrides: { currentSlot: 0 } },
		{ named: "a hotbar slot past the ninth", overrides: { currentSlot: 10 } },
		{ named: "a pitch below straight down", overrides: { pitch: -91 } },
		{ named: "a pitch above straight up", overrides: { pitch: 91 } },
		{ named: "a tps of zero, which the client never samples", overrides: { tps: 0 } },
		{ named: "a tps above the twenty the client caps at", overrides: { tps: 20.1 } },
	])("refuses $named", ({ overrides }) => {
		expect(() => playerStatsFrom(reply(statsWith(overrides)))).toThrow(McpProtocolError)
	})

	it.each([
		{ named: "the pitch floor", overrides: { pitch: -90 } },
		{ named: "the pitch ceiling", overrides: { pitch: 90 } },
		{ named: "the tps ceiling", overrides: { tps: 20 } },
		{ named: "the ninth hotbar slot", overrides: { currentSlot: 9 } },
		{ named: "a gamemode of three", overrides: { gamemode: 3 } },
		{ named: "zero health, which a dead player has", overrides: { health: 0 } },
	])("accepts $named", ({ overrides }) => {
		expect(() => playerStatsFrom(reply(statsWith(overrides)))).not.toThrow()
	})
})

const effect = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: "Speed",
	name: "Swiftness",
	amplifier: 1,
	remainingSeconds: 42,
	isInfinite: false,
	...overrides,
})

const effectsPayload = (effects: readonly unknown[], count?: unknown): Record<string, unknown> => ({
	count: count === undefined ? effects.length : count,
	effects,
})

const EFFECT_FIELDS = ["id", "amplifier", "remainingSeconds", "isInfinite"] as const

describe("reading the status effects readout", () => {
	it("keeps exactly the four retained fields, dropping the display name and the count", () => {
		expect(statusEffectsFrom(reply(effectsPayload([effect()])))).toEqual([
			{ id: "Speed", amplifier: 1, remainingSeconds: 42, isInfinite: false },
		])
	})

	it("reads an empty effect list as an empty list, not as absent", () => {
		expect(statusEffectsFrom(reply(effectsPayload([])))).toEqual([])
	})

	it.each(EFFECT_IDS)("accepts the effect the client calls %s", (id) => {
		expect(statusEffectsFrom(reply(effectsPayload([effect({ id })])))[0]?.id).toBe(id)
	})

	it.each([
		{ named: "an enchantment name, which is not an effect", id: "Sharpness" },
		{ named: "a decimal id, which is what an unknown enum would stringify to", id: "37" },
	])("refuses $named", ({ id }) => {
		expect(() => statusEffectsFrom(reply(effectsPayload([effect({ id })])))).toThrow(
			McpProtocolError,
		)
	})

	it("reads an infinite effect, which the client reports as minus one second", () => {
		expect(
			statusEffectsFrom(
				reply(effectsPayload([effect({ remainingSeconds: -1, isInfinite: true })])),
			),
		).toEqual([{ id: "Speed", amplifier: 1, remainingSeconds: -1, isInfinite: true }])
	})

	it.each([
		{
			named: "an infinite flag without the minus one",
			overrides: { remainingSeconds: 42, isInfinite: true },
		},
		{
			named: "a minus one without the infinite flag",
			overrides: { remainingSeconds: -1, isInfinite: false },
		},
	])("refuses $named, because the two must agree", ({ overrides }) => {
		expect(() => statusEffectsFrom(reply(effectsPayload([effect(overrides)])))).toThrow(
			McpProtocolError,
		)
	})

	it.each([
		{ named: "a fractional amplifier", overrides: { amplifier: 1.5 } },
		{ named: "fractional remaining seconds", overrides: { remainingSeconds: 42.5 } },
		{ named: "an amplifier below zero", overrides: { amplifier: -1 } },
		{ named: "an amplifier above the cap", overrides: { amplifier: 256 } },
		{ named: "a second negative remaining time", overrides: { remainingSeconds: -2 } },
		{
			named: "remaining seconds past what the client can compute",
			overrides: { remainingSeconds: 107374183 },
		},
		{ named: "an id delivered as an array that would coerce valid", overrides: { id: ["Speed"] } },
		{ named: "a stringly amplifier", overrides: { amplifier: "1" } },
		{
			named: "stringly remaining seconds that would coerce to a valid count",
			overrides: { remainingSeconds: "1" },
		},
		{ named: "a stringly infinite flag", overrides: { isInfinite: "false" } },
		{ named: "a numeric infinite flag", overrides: { isInfinite: 0 } },
	])("refuses $named", ({ overrides }) => {
		expect(() => statusEffectsFrom(reply(effectsPayload([effect(overrides)])))).toThrow(
			McpProtocolError,
		)
	})

	it("accepts the greatest remaining time the client can compute", () => {
		expect(
			statusEffectsFrom(reply(effectsPayload([effect({ remainingSeconds: 107374182 })])))[0]
				?.remainingSeconds,
		).toBe(107374182)
	})

	it.each(EFFECT_FIELDS)("refuses a null %s", (field) => {
		expect(() => statusEffectsFrom(reply(effectsPayload([effect({ [field]: null })])))).toThrow(
			McpProtocolError,
		)
	})

	it.each(EFFECT_FIELDS)("refuses an effect with %s missing", (field) => {
		const entry = effect()
		delete entry[field]
		expect(() => statusEffectsFrom(reply(effectsPayload([entry])))).toThrow(McpProtocolError)
	})

	it.each([
		{ named: "a null effect entry", effects: [null] },
		{ named: "a null effects array", effects: null },
		{ named: "an object where the effects array belongs", effects: { first: effect() } },
	])("refuses $named", ({ effects }) => {
		expect(() => statusEffectsFrom(reply(effectsPayload([], effects)))).toThrow(McpProtocolError)
	})

	it("refuses a payload with the effects array missing", () => {
		expect(() => statusEffectsFrom(reply({ count: 0 }))).toThrow(McpProtocolError)
	})

	it.each([
		{ named: "a null count", count: null },
		{ named: "a stringly count", count: "1" },
		{ named: "a count one too high", count: 2 },
		{ named: "a count one too low", count: 0 },
	])("refuses $named", ({ count }) => {
		expect(() => statusEffectsFrom(reply(effectsPayload([effect()], count)))).toThrow(
			McpProtocolError,
		)
	})

	it("refuses a payload with the count missing", () => {
		expect(() => statusEffectsFrom(reply({ effects: [effect()] }))).toThrow(McpProtocolError)
	})

	it.each([
		{ named: "a null payload where the wrapper belongs", payload: null },
		{ named: "an array where the wrapper object belongs", payload: [] },
	])("refuses $named", ({ payload }) => {
		expect(() => statusEffectsFrom(reply(payload))).toThrow(McpProtocolError)
	})

	it("accepts one effect of every kind at once, which is all the client can hold", () => {
		const all = EFFECT_IDS.map((id) => effect({ id }))

		expect(statusEffectsFrom(reply(effectsPayload(all)))).toHaveLength(32)
	})

	it("refuses more effects than the client can hold", () => {
		const tooMany = [...EFFECT_IDS.map((id) => effect({ id })), effect({ id: "Speed" })]

		expect(() => statusEffectsFrom(reply(effectsPayload(tooMany)))).toThrow(McpProtocolError)
	})
})

const bot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	name: "AutoRelog",
	fullTypeName: "MinecraftClient.ChatBots.AutoRelog",
	isScript: false,
	...overrides,
})

const botsPayload = (bots: readonly unknown[], count?: unknown): Record<string, unknown> => ({
	count: count === undefined ? bots.length : count,
	bots,
})

describe("reading the loaded bots readout", () => {
	it("keeps the name and the script flag, dropping the full type name and the count", () => {
		expect(loadedBotsFrom(reply(botsPayload([bot()])))).toEqual([
			{ name: "AutoRelog", isScript: false },
		])
	})

	it("reads an empty bot list as an empty list, not as absent", () => {
		expect(loadedBotsFrom(reply(botsPayload([])))).toEqual([])
	})

	it("accepts a name of exactly sixty-four characters, which the grammar allows", () => {
		const name = `A${"a".repeat(63)}`
		expect(name).toHaveLength(64)

		expect(loadedBotsFrom(reply(botsPayload([bot({ name })])))[0]?.name).toBe(name)
	})

	it.each([
		{ named: "a name one character too long", name: `A${"a".repeat(64)}` },
		{ named: "an empty name", name: "" },
		{ named: "a name starting with a digit", name: "1Bot" },
		{ named: "a name holding a space", name: "Bot Name" },
	])("refuses $named", ({ name }) => {
		expect(() => loadedBotsFrom(reply(botsPayload([bot({ name })])))).toThrow(McpProtocolError)
	})

	it.each([
		{ named: "a name delivered as true, which would coerce to a valid name", name: true },
		{ named: "a null name", name: null },
	])("refuses $named", ({ name }) => {
		expect(() => loadedBotsFrom(reply(botsPayload([bot({ name })])))).toThrow(McpProtocolError)
	})

	it.each([
		{ named: "a stringly script flag", isScript: "false" },
		{ named: "a numeric script flag", isScript: 0 },
		{ named: "a null script flag", isScript: null },
	])("refuses $named", ({ isScript }) => {
		expect(() => loadedBotsFrom(reply(botsPayload([bot({ isScript })])))).toThrow(McpProtocolError)
	})

	it.each(["name", "isScript"] as const)("refuses a bot with %s missing", (field) => {
		const entry = bot()
		delete entry[field]
		expect(() => loadedBotsFrom(reply(botsPayload([entry])))).toThrow(McpProtocolError)
	})

	it.each([
		{ named: "a null bot entry", bots: [null] },
		{ named: "a null bots array", bots: null },
		{ named: "an object where the bots array belongs", bots: { first: bot() } },
	])("refuses $named", ({ bots }) => {
		expect(() => loadedBotsFrom(reply(botsPayload([], bots)))).toThrow(McpProtocolError)
	})

	it("refuses a payload with the bots array missing", () => {
		expect(() => loadedBotsFrom(reply({ count: 0 }))).toThrow(McpProtocolError)
	})

	it.each([
		{ named: "a null count", count: null },
		{ named: "a stringly count", count: "1" },
		{ named: "a count one too high", count: 2 },
		{ named: "a count one too low", count: 0 },
	])("refuses $named", ({ count }) => {
		expect(() => loadedBotsFrom(reply(botsPayload([bot()], count)))).toThrow(McpProtocolError)
	})

	it("refuses a payload with the count missing", () => {
		expect(() => loadedBotsFrom(reply({ bots: [bot()] }))).toThrow(McpProtocolError)
	})

	it.each([
		{ named: "a null payload where the wrapper belongs", payload: null },
		{ named: "an array where the wrapper object belongs", payload: [] },
	])("refuses $named", ({ payload }) => {
		expect(() => loadedBotsFrom(reply(payload))).toThrow(McpProtocolError)
	})

	it("accepts as many bots as an operator could plausibly load", () => {
		const many = Array.from({ length: 64 }, (_, index) => bot({ name: `Bot_${index}` }))

		expect(loadedBotsFrom(reply(botsPayload(many)))).toHaveLength(64)
	})

	it("refuses more bots than the cap allows", () => {
		const many = Array.from({ length: 65 }, (_, index) => bot({ name: `Bot_${index}` }))

		expect(() => loadedBotsFrom(reply(botsPayload(many)))).toThrow(McpProtocolError)
	})
})

describe("reading the players readout", () => {
	it("keeps the names the client reports", () => {
		expect(playersListFrom(reply({ players: ["Steve", "Alex_99"] }))).toEqual(["Steve", "Alex_99"])
	})

	it("reads an empty server as an empty list, not as absent", () => {
		expect(playersListFrom(reply({ players: [] }))).toEqual([])
	})

	it("accepts a name of the sixteen characters the protocol allows", () => {
		const name = "a".repeat(16)

		expect(playersListFrom(reply({ players: [name] }))).toEqual([name])
	})

	it.each([
		{ named: "an empty name", player: "" },
		{ named: "a name holding a space", player: "a b" },
		{ named: "a name one character too long", player: "a".repeat(17) },
		{ named: "a name holding a placeholder character", player: "0000tab#" },
		{ named: "a name delivered as a number that would coerce valid", player: 1 },
		{ named: "a null name", player: null },
	])("refuses $named", ({ player }) => {
		expect(() => playersListFrom(reply({ players: [player] }))).toThrow(McpProtocolError)
	})

	it.each([
		{ named: "a null players array", players: null },
		{ named: "an object where the players array belongs", players: { first: "Steve" } },
	])("refuses $named", ({ players }) => {
		expect(() => playersListFrom(reply({ players }))).toThrow(McpProtocolError)
	})

	it("refuses a payload with the players array missing", () => {
		expect(() => playersListFrom(reply({}))).toThrow(McpProtocolError)
	})

	it.each([
		{ named: "a null payload where the wrapper belongs", payload: null },
		{ named: "an array where the wrapper object belongs", payload: [] },
	])("refuses $named", ({ payload }) => {
		expect(() => playersListFrom(reply(payload))).toThrow(McpProtocolError)
	})

	it("accepts a full server", () => {
		const many = Array.from({ length: 1000 }, (_, index) => `Player_${index}`)

		expect(playersListFrom(reply({ players: many }))).toHaveLength(1000)
	})

	it("refuses more players than the response guard allows", () => {
		const many = Array.from({ length: 1001 }, (_, index) => `Player_${index}`)

		expect(() => playersListFrom(reply({ players: many }))).toThrow(McpProtocolError)
	})
})

const ADDRESS_TOKEN = "10.42.0.7:33333"
const CREDENTIAL_TOKEN = "MCC_MCP_AUTH_TOKEN=s3cr3t-value"

const failureReply = (message: string) =>
	responseFrom(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: { structuredContent: { success: false, error: message }, content: [] },
		}),
	)

describe("what a refused readout carries inward", () => {
	const readers = [
		{ named: "player stats", read: playerStatsFrom },
		{ named: "status effects", read: statusEffectsFrom },
		{ named: "loaded bots", read: loadedBotsFrom },
		{ named: "players list", read: playersListFrom },
	] as const

	it.each(readers)(
		"carries the client's own words inward when $named is refused, which is why they must never reach an operator",
		({ read }) => {
			const remote = `connect ${ADDRESS_TOKEN} failed with ${CREDENTIAL_TOKEN}`

			expect(() => read(failureReply(remote))).toThrow(McpProtocolError)
			try {
				read(failureReply(remote))
			} catch (error) {
				expect(error instanceof Error ? error.message : "").toContain(ADDRESS_TOKEN)
				expect(error instanceof Error ? error.message : "").toContain(CREDENTIAL_TOKEN)
			}
		},
	)
})

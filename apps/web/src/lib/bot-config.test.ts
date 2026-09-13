import { type InstanceConfigInput, instanceConfigInput } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import {
	type BotConfigDraft,
	clearValue,
	draftFrom,
	effectiveValue,
	isStored,
	savedFrom,
	storeValue,
	unmetDependency,
	validateBotConfig,
} from "./bot-config"

const INSTANCE: InstanceConfigInput = instanceConfigInput.parse({
	accountType: "offline",
	minecraftAccount: "OpenMccBot",
	serverAddress: "play.example.com:25565",
	autoRelogRetries: 3,
	autoRelogEnabled: true,
	autoRelogDelaySeconds: { min: 5, max: 20 },
	antiAfkEnabled: true,
	antiAfkIntervalSeconds: { min: 90, max: 300 },
})

const WITH_WORLD_AND_ENTITIES: InstanceConfigInput = {
	...INSTANCE,
	worldDataEnabled: true,
	entityDataEnabled: true,
}

const EMPTY = { botConfig: {}, advancedKeys: {} }

describe("what the operator has actually chosen", () => {
	it("treats a key it was never given as unset", () => {
		expect(isStored({}, "ChatBot.Map.Enabled")).toBe(false)
	})

	it("falls back to the client's own default for an unset key", () => {
		expect(effectiveValue({}, "ChatBot.Mailer.MaxMailsPerPlayer")).toBe("10")
		expect(effectiveValue({}, "ChatBot.RemoteControl.AutoTpaccept")).toBe("true")
	})

	it("falls back to the client's default for one of the eight bots too", () => {
		expect(effectiveValue({}, "ChatBot.AutoFishing.Durability_Limit")).toBe("2.0")
		expect(effectiveValue({}, "ChatBot.AutoDig.Durability_Limit")).toBe("2")
	})

	it("★ stores a value even when it equals the client's default, which is what pins it", () => {
		const draft = storeValue({}, "ChatBot.RemoteControl.AutoTpaccept", "true")

		expect(isStored(draft, "ChatBot.RemoteControl.AutoTpaccept")).toBe(true)
		expect(draft["ChatBot.RemoteControl.AutoTpaccept"]).toBe("true")
	})

	it("removes the key entirely when the operator goes back to the client's default", () => {
		const draft = storeValue({}, "ChatBot.Mailer.MaxMailsPerPlayer", "256")

		expect(
			Object.hasOwn(
				clearValue(draft, "ChatBot.Mailer.MaxMailsPerPlayer"),
				"ChatBot.Mailer.MaxMailsPerPlayer",
			),
		).toBe(false)
	})
})

describe("★ one draft over two stored fields", () => {
	it("reads both fields into the same draft", () => {
		const draft = draftFrom({
			botConfig: { "ChatBot.Map.Enabled": "true" },
			advancedKeys: { "ChatBot.AutoEat.Threshold": "9" },
		})

		expect(draft["ChatBot.Map.Enabled"]).toBe("true")
		expect(draft["ChatBot.AutoEat.Threshold"]).toBe("9")
	})

	it("★ writes each key back to the field it came from, so neither save clobbers the other", () => {
		const draft = draftFrom({
			botConfig: { "ChatBot.Map.Enabled": "true" },
			advancedKeys: { "ChatBot.AutoEat.Threshold": "9" },
		})

		expect(savedFrom(draft)).toEqual({
			botConfig: { "ChatBot.Map.Enabled": "true" },
			advancedKeys: { "ChatBot.AutoEat.Threshold": "9" },
		})
	})

	it("★ keeps an audited key out of the bot config, which is strict and would refuse it", () => {
		const saved = savedFrom(storeValue({}, "ChatBot.AutoEat.Threshold", "9"))

		expect(saved.botConfig).toEqual({})
		expect(saved.advancedKeys).toEqual({ "ChatBot.AutoEat.Threshold": "9" })
	})

	it("saves an empty pair for an instance that has set nothing", () => {
		expect(savedFrom(draftFrom(EMPTY))).toEqual({ botConfig: {}, advancedKeys: {} })
	})
})

describe("what the operator is told is wrong", () => {
	it("says nothing when every value is good", () => {
		expect(validateBotConfig({ "ChatBot.Mailer.MaxMailsPerPlayer": "256" })).toEqual({})
	})

	it("names the field and what it wants", () => {
		expect(validateBotConfig({ "ChatBot.Mailer.MaxMailsPerPlayer": "0" })).toEqual({
			"ChatBot.Mailer.MaxMailsPerPlayer": "Between 1 and 2147483647",
		})
	})

	it("reports every bad field, not just the first", () => {
		const issues = validateBotConfig({
			"ChatBot.Mailer.MaxMailsPerPlayer": "0",
			"ChatBot.PlayerListLogger.File": "../escape",
		})

		expect(Object.keys(issues).sort()).toEqual([
			"ChatBot.Mailer.MaxMailsPerPlayer",
			"ChatBot.PlayerListLogger.File",
		])
	})

	it("checks the audited keys under their own schemas too", () => {
		expect(validateBotConfig({ "ChatBot.AutoEat.Threshold": "21" })).toEqual({
			"ChatBot.AutoEat.Threshold": "Between 0 and 20",
		})
	})
})

describe("★ the attack cooldown, which the client swaps rather than clamps", () => {
	const CUSTOM = "ChatBot.AutoAttack.Cooldown_Time.Custom"
	const MIN = "ChatBot.AutoAttack.Cooldown_Time.Min"
	const MAX = "ChatBot.AutoAttack.Cooldown_Time.Max"

	it("refuses a shortest above the longest, on both keys, because the client swaps them", () => {
		expect(validateBotConfig({ [CUSTOM]: "true", [MIN]: "3.0", [MAX]: "1.0" })).toEqual({
			[MIN]: "Above the maximum (1)",
			[MAX]: "Below the minimum (3)",
		})
	})

	it("★ compares a lone shortest against the client's own longest, not against nothing", () => {
		expect(validateBotConfig({ [CUSTOM]: "true", [MIN]: "3.0" })).toEqual({
			[MIN]: "Above the maximum (2.5)",
		})
	})

	it("★ compares a lone longest against the client's own shortest", () => {
		expect(validateBotConfig({ [CUSTOM]: "true", [MAX]: "1.0" })).toEqual({
			[MAX]: "Below the minimum (1.5)",
		})
	})

	it("accepts a lone value that sits inside the client's own pair", () => {
		expect(validateBotConfig({ [CUSTOM]: "true", [MIN]: "2.0" })).toEqual({})
		expect(validateBotConfig({ [CUSTOM]: "true", [MAX]: "2.0" })).toEqual({})
	})

	it("refuses zero and below on either side", () => {
		expect(validateBotConfig({ [CUSTOM]: "true", [MIN]: "0.0", [MAX]: "2.0" })).toEqual({
			[MIN]: "More than 0",
		})
	})

	it("★ flags both keys when a zero longest also leaves the shortest above it, since the client moves both", () => {
		expect(validateBotConfig({ [CUSTOM]: "true", [MIN]: "1.0", [MAX]: "0.0" })).toEqual({
			[MIN]: "Above the maximum (0)",
			[MAX]: "More than 0",
		})
	})

	it("accepts a pair that is equal, which the client leaves alone", () => {
		expect(validateBotConfig({ [CUSTOM]: "true", [MIN]: "2.0", [MAX]: "2.0" })).toEqual({})
	})

	it("★ says nothing at all while the operator has not taken the delay over", () => {
		expect(validateBotConfig({ [CUSTOM]: "false", [MIN]: "3.0", [MAX]: "1.0" })).toEqual({})
		expect(validateBotConfig({ [MIN]: "3.0", [MAX]: "1.0" })).toEqual({})
	})

	it("★ keeps a bad value's own complaint, and weighs its partner against the client's default instead", () => {
		const issues = validateBotConfig({ [CUSTOM]: "true", [MIN]: "not a number", [MAX]: "1.0" })

		expect(issues[MIN]).toBe("Decimal number")
		expect(issues[MAX]).toBe("Below the minimum (1.5)")
	})
})

describe("a setting that does nothing until another is on", () => {
	it("says so when its sibling is off", () => {
		expect(unmetDependency({}, INSTANCE, "ChatBot.Alerts.Matches")).toEqual({
			requires: "Alert on matched words",
		})
	})

	it("stays quiet once the sibling is on", () => {
		const draft = storeValue({}, "ChatBot.Alerts.Trigger_By_Words", "true")

		expect(unmetDependency(draft, INSTANCE, "ChatBot.Alerts.Matches")).toBeUndefined()
	})

	it("★ reads the sibling's EFFECTIVE value, so a client default of on counts as on", () => {
		expect(
			unmetDependency({}, INSTANCE, "ChatBot.RemoteControl.AutoTpaccept_Everyone"),
		).toBeUndefined()
	})

	it("names both instance settings the follow bot needs when neither is on", () => {
		expect(unmetDependency({}, INSTANCE, "ChatBot.FollowPlayer.Enabled")).toEqual({
			requires: "World and position and Nearby entities",
		})
	})

	it("stays quiet once the instance provides both", () => {
		expect(
			unmetDependency({}, WITH_WORLD_AND_ENTITIES, "ChatBot.FollowPlayer.Enabled"),
		).toBeUndefined()
	})

	it("says nothing about a setting that depends on nothing", () => {
		expect(unmetDependency({}, INSTANCE, "ChatBot.Map.Enabled")).toBeUndefined()
	})
})

describe("switching a section off", () => {
	it("★ keeps every value the operator set inside it, so nothing is lost by hiding it", () => {
		const configured: BotConfigDraft = {
			"ChatBot.Alerts.Enabled": "true",
			"ChatBot.PlayerListLogger.File": "mine.txt",
			"ChatBot.Alerts.Matches": ["admin"],
		}

		const off = storeValue(configured, "ChatBot.Alerts.Enabled", "false")

		expect(off).toEqual({
			"ChatBot.Alerts.Enabled": "false",
			"ChatBot.PlayerListLogger.File": "mine.txt",
			"ChatBot.Alerts.Matches": ["admin"],
		})
	})
})

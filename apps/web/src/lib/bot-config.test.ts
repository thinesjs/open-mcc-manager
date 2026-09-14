import { type InstanceConfigInput, instanceConfigInput } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import {
	type BotConfigDraft,
	clearValue,
	describeUnmetDependency,
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

const WITH_WORLD: InstanceConfigInput = { ...INSTANCE, worldDataEnabled: true }

const WITH_ENTITIES: InstanceConfigInput = { ...INSTANCE, entityDataEnabled: true }

const WITH_EVERYTHING: InstanceConfigInput = {
	...INSTANCE,
	worldDataEnabled: true,
	inventoryDataEnabled: true,
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

	it("★ flags a saved bot file the client already uses, so the operator sees it on opening the form", () => {
		const draft = draftFrom({
			botConfig: { "ChatBot.PlayerListLogger.File": "env" },
			advancedKeys: {},
		})

		expect(validateBotConfig(draft)).toEqual({
			"ChatBot.PlayerListLogger.File": "The client already uses that file name",
		})
	})

	it("★ flags a file another setting already names, even one left on its default", () => {
		expect(validateBotConfig({ "ChatBot.Mailer.DatabaseFile": "playerlog.txt" })).toEqual({
			"ChatBot.Mailer.DatabaseFile": "Another setting already uses that file name",
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
			requires: ["Alert on matched words"],
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
			requires: ["World and position", "Nearby entities"],
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

describe("★ walking a chain of prerequisites rather than reporting only the first", () => {
	const TOOL_SWITCH = "ChatBot.AutoDig.Auto_Tool_Switch"
	const ON: BotConfigDraft = { [TOOL_SWITCH]: "true" }

	it("names the nearest prerequisite while that one is still off", () => {
		expect(unmetDependency({}, WITH_EVERYTHING, "ChatBot.AutoDig.Durability_Limit")).toEqual({
			requires: ["Switch to the right tool"],
		})
	})

	it("★ walks past a met sibling to the instance setting THAT one needs", () => {
		expect(unmetDependency(ON, WITH_WORLD, "ChatBot.AutoDig.Durability_Limit")).toEqual({
			requires: ["Inventory"],
		})
	})

	it("★ reports both instance settings from the far end of the chain, not one", () => {
		expect(unmetDependency(ON, INSTANCE, "ChatBot.AutoDig.Drop_Low_Durability_Tools")).toEqual({
			requires: ["World and position", "Inventory"],
		})
	})

	it("goes quiet once every step of the chain is met", () => {
		expect(unmetDependency(ON, WITH_EVERYTHING, "ChatBot.AutoDig.Durability_Limit")).toBeUndefined()
	})

	it("★ reports the sibling first even when the instance end is also unmet", () => {
		expect(unmetDependency({}, INSTANCE, "ChatBot.AutoDig.Durability_Limit")).toEqual({
			requires: ["Switch to the right tool"],
		})
	})
})

describe("★ a key whose own rule must not be replaced by its section's", () => {
	it("names the rod checks' inventory AND the section's entities", () => {
		expect(unmetDependency({}, INSTANCE, "ChatBot.AutoFishing.Durability_Limit")).toEqual({
			requires: ["Inventory", "Nearby entities"],
		})
		expect(unmetDependency({}, INSTANCE, "ChatBot.AutoFishing.Auto_Rod_Switch")).toEqual({
			requires: ["Inventory", "Nearby entities"],
		})
	})

	it("★ still names inventory once the section's own requirement is met", () => {
		expect(unmetDependency({}, WITH_ENTITIES, "ChatBot.AutoFishing.Durability_Limit")).toEqual({
			requires: ["Inventory"],
		})
	})

	it("names world AND entities for moving between spots", () => {
		expect(unmetDependency({}, INSTANCE, "ChatBot.AutoFishing.Enable_Move")).toEqual({
			requires: ["World and position", "Nearby entities"],
		})
		expect(unmetDependency({}, WITH_ENTITIES, "ChatBot.AutoFishing.Enable_Move")).toEqual({
			requires: ["World and position"],
		})
	})

	it("names inventory AND world for the tool switch", () => {
		expect(unmetDependency({}, INSTANCE, "ChatBot.AutoDig.Auto_Tool_Switch")).toEqual({
			requires: ["World and position", "Inventory"],
		})
	})
})

describe("★ the fields the client reads whatever else is off", () => {
	const DETECTION_OFF: BotConfigDraft = {
		"ChatBot.AutoFishing.Enable_Velocity_Detection": "false",
		"ChatBot.AutoFishing.Enable_Sound_Detection": "false",
	}

	it("★ never gates the bite warm-up on a detection toggle, because every catch waits for it", () => {
		expect(
			unmetDependency(DETECTION_OFF, WITH_ENTITIES, "ChatBot.AutoFishing.Detection_Warmup"),
		).toBeUndefined()
	})

	it("gates each bite threshold on its own detection toggle", () => {
		expect(
			unmetDependency(DETECTION_OFF, WITH_ENTITIES, "ChatBot.AutoFishing.Velocity_Hook_Threshold"),
		).toEqual({ requires: ["Detect bites from bobber movement"] })
		expect(
			unmetDependency(DETECTION_OFF, WITH_ENTITIES, "ChatBot.AutoFishing.Sound_Distance"),
		).toEqual({ requires: ["Detect bites from the splash sound"] })
	})

	it("★ never gates the dig timing options on the tool switch, which is read past them", () => {
		expect(
			unmetDependency({}, WITH_WORLD, "ChatBot.AutoDig.Apply_Efficiency_Enchantments"),
		).toBeUndefined()
		expect(unmetDependency({}, WITH_WORLD, "ChatBot.AutoDig.Apply_Haste_Effects")).toBeUndefined()
	})
})

describe("★ the instance settings each of the eight bots cannot work without", () => {
	const ROWS = [
		{ key: "ChatBot.AutoAttack.Enabled", requires: ["Nearby entities"] },
		{ key: "ChatBot.AutoFishing.Enabled", requires: ["Nearby entities"] },
		{ key: "ChatBot.ItemsCollector.Enabled", requires: ["World and position", "Nearby entities"] },
		{ key: "ChatBot.AutoDig.Enabled", requires: ["World and position"] },
		{ key: "ChatBot.Farmer.Enabled", requires: ["World and position", "Inventory"] },
		{ key: "ChatBot.AutoCraft.Enabled", requires: ["Inventory"] },
		{ key: "ChatBot.AutoDrop.Enabled", requires: ["Inventory"] },
		{ key: "ChatBot.AutoEat.Enabled", requires: ["Inventory"] },
	] as const

	it.each(ROWS)("tells the operator $key needs $requires", ({ key, requires }) => {
		expect(unmetDependency({}, INSTANCE, key)).toEqual({ requires })
	})

	it.each(ROWS)("goes quiet for $key once the instance provides them", ({ key }) => {
		expect(unmetDependency({}, WITH_EVERYTHING, key)).toBeUndefined()
	})
})

describe("the sentence a requirement is shown as", () => {
	it("says one setting is on", () => {
		expect(describeUnmetDependency({ requires: ["Inventory"] })).toBe(
			"Does nothing until Inventory is on.",
		)
	})

	it("lists several without joining names that already carry an and", () => {
		expect(describeUnmetDependency({ requires: ["World and position", "Nearby entities"] })).toBe(
			"Does nothing until these are on: World and position, Nearby entities.",
		)
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

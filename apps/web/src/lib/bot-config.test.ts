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

describe("what the operator has actually chosen", () => {
	it("treats a key it was never given as unset", () => {
		expect(isStored({}, "ChatBot.Map.Enabled")).toBe(false)
	})

	it("falls back to the client's own default for an unset key", () => {
		expect(effectiveValue({}, "ChatBot.Mailer.MaxMailsPerPlayer")).toBe("10")
		expect(effectiveValue({}, "ChatBot.RemoteControl.AutoTpaccept")).toBe("true")
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

	it("carries a saved config into a draft and back again", () => {
		const draft = draftFrom({ "ChatBot.Map.Enabled": "true" })

		expect(savedFrom(draft)).toEqual({ "ChatBot.Map.Enabled": "true" })
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

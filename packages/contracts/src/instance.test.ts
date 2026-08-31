import { describe, expect, it } from "vitest"
import { createInstanceInput, INSTANCE_ID_PATTERN, instanceConfigInput } from "./instance"

describe("instance contracts", () => {
	it("rejects an id carrying a systemd specifier or a path separator", () => {
		expect(INSTANCE_ID_PATTERN.test("V1StGXR8Z5jdHi6B")).toBe(true)
		expect(INSTANCE_ID_PATTERN.test("a%i")).toBe(false)
		expect(INSTANCE_ID_PATTERN.test("a/b")).toBe(false)
		expect(INSTANCE_ID_PATTERN.test("a b")).toBe(false)
		expect(INSTANCE_ID_PATTERN.test("")).toBe(false)
	})

	it("strips any config key outside the typed set, so one can never reach the serializer", () => {
		const parsed = instanceConfigInput.safeParse({
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
			autoRelogRetries: 3,
			autoRelogDelaySeconds: 10,
			antiAfkEnabled: true,
			antiAfkIntervalSeconds: 60,
			scriptFile: "evil",
			"ChatBot.Script.Script_File": "evil",
		})
		expect(parsed.success).toBe(true)
		expect(Object.keys(parsed.data ?? {}).sort()).toEqual([
			"antiAfkEnabled",
			"antiAfkIntervalSeconds",
			"autoRelogDelaySeconds",
			"autoRelogRetries",
			"minecraftAccount",
			"serverAddress",
		])
	})

	it("requires a real email for the account the instance logs in as", () => {
		expect(
			createInstanceInput.safeParse({
				hostId: "h1",
				name: "afk-1",
				minecraftAccount: "notanemail",
				serverAddress: "play.example.com",
			}).success,
		).toBe(false)
	})
})

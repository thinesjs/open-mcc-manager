import { ADVANCED_KEY_NAMES } from "@open-mcc/contracts/boundary/mcc-config-keys"
import { describe, expect, it } from "vitest"
import { defaultInstanceConfig, FIXED_CONFIG_KEYS, renderInstanceConfig } from "./config"
import {
	compareInstanceConfig,
	formatConfigValue,
	isOperatorKey,
	isSafetyDrift,
} from "./config-drift"

const BASE = defaultInstanceConfig({
	accountType: "offline",
	minecraftAccount: "OpenMccBot",
	serverAddress: "100.101.102.103",
})

const EXPECTED = renderInstanceConfig(BASE)

const GATES = [
	"ChatBot.AutoRespond.Enabled",
	"ChatBot.ScriptScheduler.Enabled",
	"ChatBot.DiscordBridge.Enabled",
	"ChatBot.TelegramBridge.Enabled",
] as const

const driftOn = (host: string, key: string) =>
	compareInstanceConfig(EXPECTED, host).filter(
		(entry) => entry.kind !== "section" && entry.key === key,
	)

describe("the gates on the client's own command surface", () => {
	it.each([...GATES, "Main.Advanced.BotOwners"])(
		"pins %s rather than trusting the client",
		(key) => {
			expect(FIXED_CONFIG_KEYS).toContain(key)
		},
	)

	it.each(GATES)("writes %s off, so the host cannot be left at the client's default", (key) => {
		const section = key.slice(0, key.lastIndexOf("."))
		const lines = EXPECTED.split("\n")
		const start = lines.indexOf(`[${section}]`)

		expect(start).toBeGreaterThan(-1)
		expect(lines[start + 1]).toBe("Enabled = false")
	})

	it("writes an empty owner list, which is what makes the whisper path dead", () => {
		expect(EXPECTED).toContain("BotOwners = []")
	})

	it.each(GATES)("calls it a safety failure when a host turns %s back on", (key) => {
		const drift = driftOn(
			EXPECTED.replace(
				`[${key.slice(0, key.lastIndexOf("."))}]\nEnabled = false`,
				`[${key.slice(0, key.lastIndexOf("."))}]\nEnabled = true`,
			),
			key,
		)

		expect(drift).toHaveLength(1)
		expect(drift[0]?.kind).toBe("fixed")
		expect(drift.every(isSafetyDrift)).toBe(true)
	})

	it("calls it a safety failure when a host names an owner", () => {
		const drift = driftOn(
			EXPECTED.replace("BotOwners = []", 'BotOwners = [ "attacker" ]'),
			"Main.Advanced.BotOwners",
		)

		expect(drift).toHaveLength(1)
		expect(drift[0]).toMatchObject({ kind: "fixed", expected: [], actual: ["attacker"] })
		expect(drift.every(isSafetyDrift)).toBe(true)
	})

	it("★ calls it a safety failure when a host DELETES the owner list, because the client then falls back to its own two names", () => {
		const drift = driftOn(EXPECTED.replace("BotOwners = []\n", ""), "Main.Advanced.BotOwners")

		expect(drift).toHaveLength(1)
		expect(drift[0]).toMatchObject({ kind: "fixed", expected: [], actual: undefined })
		expect(drift.every(isSafetyDrift)).toBe(true)
	})

	it("reports nothing when the host holds exactly what was pinned", () => {
		expect(compareInstanceConfig(EXPECTED, EXPECTED)).toEqual([])
	})

	it("tells two different owner lists apart, which a range comparison would not", () => {
		const withOne = EXPECTED.replace("BotOwners = []", 'BotOwners = [ "a" ]')
		const withOther = EXPECTED.replace("BotOwners = []", 'BotOwners = [ "b" ]')

		expect(driftOn(withOther, "Main.Advanced.BotOwners")).toHaveLength(1)
		expect(compareInstanceConfig(withOne, withOther)).toHaveLength(1)
		expect(compareInstanceConfig(withOne, withOne)).toEqual([])
	})

	it.each([...GATES, "Main.Advanced.BotOwners"])(
		"keeps %s out of the operator's registry, so its pin cannot be downgraded",
		(key) => {
			expect(ADVANCED_KEY_NAMES).not.toContain(key)
			expect(isOperatorKey(key)).toBe(false)
		},
	)
})

describe("how an owner list is shown and read", () => {
	it("writes an empty list as words the operator can read, not as an object", () => {
		expect(formatConfigValue([])).toBe("[]")
	})

	it("names every entry when a host has some", () => {
		expect(formatConfigValue(["player1", "player2"])).toBe("[player1, player2]")
	})

	it("carries that wording into the payload the browser receives", () => {
		const drift = driftOn(
			EXPECTED.replace("BotOwners = []", 'BotOwners = [ "attacker" ]'),
			"Main.Advanced.BotOwners",
		)
		const entry = drift[0]
		if (entry === undefined || entry.kind !== "fixed") {
			throw new Error("expected the pinned owner list to drift as a safety failure")
		}

		expect(formatConfigValue(entry.expected)).toBe("[]")
	})

	it.each([
		{ named: "a list of tables", written: 'BotOwners = [ { name = "a" } ]' },
		{ named: "a nested list", written: 'BotOwners = [ [ "a" ] ]' },
	])("still calls $named a safety failure rather than letting an odd shape pass", ({ written }) => {
		const host = EXPECTED.replace("BotOwners = []", written)
		const drift = compareInstanceConfig(EXPECTED, host).filter(
			(entry) => entry.kind !== "section" && entry.key === "Main.Advanced.BotOwners",
		)

		expect(drift).toHaveLength(1)
		expect(drift[0]?.kind).toBe("fixed")
	})
})

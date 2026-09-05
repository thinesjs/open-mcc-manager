import { describe, expect, it } from "vitest"
import {
	ACCOUNT_TYPE_LABELS,
	ACCOUNT_TYPES,
	createInstanceInput,
	INSTANCE_ID_PATTERN,
	instanceConfigInput,
	isOfflineAccount,
	needsInteractiveSignIn,
} from "./instance"

describe("instance contracts", () => {
	it("rejects an id carrying a systemd specifier or a path separator", () => {
		expect(INSTANCE_ID_PATTERN.test("V1StGXR8Z5jdHi6B")).toBe(true)
		expect(INSTANCE_ID_PATTERN.test("a%i")).toBe(false)
		expect(INSTANCE_ID_PATTERN.test("a/b")).toBe(false)
		expect(INSTANCE_ID_PATTERN.test("a b")).toBe(false)
		expect(INSTANCE_ID_PATTERN.test("")).toBe(false)
	})

	it("refuses a config write naming a script key, which is what stops config from reaching CSharpRunner", () => {
		const parsed = instanceConfigInput.safeParse({
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
			autoRelogRetries: 3,
			autoRelogDelaySeconds: 10,
			antiAfkEnabled: true,
			antiAfkIntervalSeconds: 60,
			"ChatBot.Script.Script_File": "evil",
		})
		expect(parsed.success).toBe(false)
		expect(JSON.stringify(parsed.error?.issues)).toContain("unrecognized")
	})

	it("refuses any unrecognised key at all, not only script-shaped ones", () => {
		const parsed = instanceConfigInput.safeParse({
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
			autoRelogRetries: 3,
			autoRelogDelaySeconds: 10,
			antiAfkEnabled: true,
			antiAfkIntervalSeconds: 60,
			harmlessLookingExtra: 1,
		})
		expect(parsed.success).toBe(false)
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

describe("account types", () => {
	it("accepts a bare username for an offline account", () => {
		const parsed = createInstanceInput.safeParse({
			hostId: "h",
			name: "n",
			accountType: "offline",
			minecraftAccount: "OpenMccBot",
			serverAddress: "play.example.net",
		})

		expect(parsed.success).toBe(true)
	})

	it("rejects an email for an offline account, which joins under an in-game name", () => {
		const parsed = createInstanceInput.safeParse({
			hostId: "h",
			name: "n",
			accountType: "offline",
			minecraftAccount: "player@example.com",
			serverAddress: "play.example.net",
		})

		expect(parsed.success).toBe(false)
	})

	it("requires an email for a Microsoft account", () => {
		const parsed = createInstanceInput.safeParse({
			hostId: "h",
			name: "n",
			accountType: "microsoft",
			minecraftAccount: "OpenMccBot",
			serverAddress: "play.example.net",
		})

		expect(parsed.success).toBe(false)
	})

	it("offers only account types whose sign-in the manager can carry out", () => {
		expect([...ACCOUNT_TYPES]).toEqual(["microsoft", "offline"])
	})

	it("separates being offline from skipping the device code, so neither stands in for the other", () => {
		for (const accountType of ACCOUNT_TYPES) {
			expect(isOfflineAccount(accountType)).toBe(!needsInteractiveSignIn(accountType))
		}
	})

	it("names every offered account type", () => {
		for (const accountType of ACCOUNT_TYPES) {
			expect(ACCOUNT_TYPE_LABELS[accountType].length).toBeGreaterThan(0)
		}
	})
})

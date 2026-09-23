import { describe, expect, it } from "vitest"
import { createInstanceInput, instanceConfigInput, instanceConfigStored } from "./instance"
import {
	MINECRAFT_VERSION_ALIASES,
	MINECRAFT_VERSION_AUTO,
	MINECRAFT_VERSION_OPTIONS,
	MINECRAFT_VERSIONS,
	minecraftVersionSchema,
} from "./minecraft-version"

const ACCEPTED: readonly string[] = MINECRAFT_VERSIONS

const A_BOT = {
	hostId: "host-1",
	name: "afk-1",
	accountType: "offline",
	minecraftAccount: "Steve",
	serverAddress: "play.skyblock.net",
} as const

const A_CONFIG = {
	accountType: "offline",
	minecraftAccount: "Steve",
	serverAddress: "play.skyblock.net",
	autoRelogRetries: 3,
	autoRelogEnabled: true,
	autoRelogDelaySeconds: { min: 10, max: 10 },
	antiAfkEnabled: false,
	antiAfkIntervalSeconds: { min: 60, max: 60 },
} as const

describe("which versions this manager will pin", () => {
	it("takes every string the client's own lookup names, and auto beside them", () => {
		for (const version of [MINECRAFT_VERSION_AUTO, ...MINECRAFT_VERSIONS]) {
			expect(minecraftVersionSchema.safeParse(version).success).toBe(true)
		}
		expect(MINECRAFT_VERSIONS).toHaveLength(131)
	})

	it("★ refuses a version the client does not know, which it would answer by silently auto-detecting", () => {
		for (const refused of ["1.21.99", "1.22", "latest", "", " 1.21", "AUTO", "Auto", "25.1"]) {
			expect(minecraftVersionSchema.safeParse(refused).success).toBe(false)
		}
	})
})

describe("what a bot is pinned to when nobody said", () => {
	it("creates a bot on auto-detect", () => {
		expect(createInstanceInput.parse(A_BOT).minecraftVersion).toBe(MINECRAFT_VERSION_AUTO)
	})

	it("reads settings saved with no version at all as auto-detect, rather than as unusable", () => {
		expect(instanceConfigInput.parse(A_CONFIG).minecraftVersion).toBe(MINECRAFT_VERSION_AUTO)
		expect(instanceConfigStored.parse(A_CONFIG).minecraftVersion).toBe(MINECRAFT_VERSION_AUTO)
	})

	it("keeps a version the operator did pin", () => {
		expect(
			createInstanceInput.parse({ ...A_BOT, minecraftVersion: "1.8.9" }).minecraftVersion,
		).toBe("1.8.9")
		expect(
			instanceConfigStored.parse({ ...A_CONFIG, minecraftVersion: "1.12.2" }).minecraftVersion,
		).toBe("1.12.2")
	})
})

describe("the versions the dashboard offers", () => {
	it("offers nothing the client would not accept", () => {
		for (const option of MINECRAFT_VERSION_OPTIONS) {
			expect(ACCEPTED).toContain(option)
		}
	})

	it("leaves out no accepted version but the aliases", () => {
		const offered: readonly string[] = MINECRAFT_VERSION_OPTIONS
		const missing = ACCEPTED.filter(
			(version) => !offered.includes(version) && !MINECRAFT_VERSION_ALIASES.includes(version),
		)

		expect(missing).toEqual([])
		expect(MINECRAFT_VERSION_OPTIONS).toHaveLength(
			MINECRAFT_VERSIONS.length - MINECRAFT_VERSION_ALIASES.length,
		)
	})

	it("★ drops only the .0 spelling of a release already offered without it, so no release is lost", () => {
		expect([...MINECRAFT_VERSION_ALIASES]).toEqual([
			"1.0.0",
			"1.1.0",
			"1.2.0",
			"1.3.0",
			"1.4.0",
			"1.5.0",
			"1.6.0",
			"1.7.0",
			"1.8.0",
			"1.9.0",
			"1.10.0",
			"1.11.0",
			"1.12.0",
			"1.13.0",
			"1.14.0",
			"1.15.0",
			"1.16.0",
			"1.17.0",
			"1.18.0",
			"1.19.0",
		])
		for (const alias of MINECRAFT_VERSION_ALIASES) {
			expect(ACCEPTED).toContain(alias.slice(0, alias.lastIndexOf(".")))
			expect(minecraftVersionSchema.safeParse(alias).success).toBe(true)
		}
	})

	it("★ lists the newest first, counting each part as a number rather than as text", () => {
		expect(MINECRAFT_VERSION_OPTIONS.slice(0, 5)).toEqual([
			"26.2",
			"26.1",
			"1.21.11",
			"1.21.10",
			"1.21.9",
		])
		expect(MINECRAFT_VERSION_OPTIONS.at(-1)).toBe("1.0")
		expect(MINECRAFT_VERSION_OPTIONS.indexOf("1.21")).toBeLessThan(
			MINECRAFT_VERSION_OPTIONS.indexOf("1.9"),
		)
		expect(MINECRAFT_VERSION_OPTIONS.indexOf("1.9.4")).toBeLessThan(
			MINECRAFT_VERSION_OPTIONS.indexOf("1.9"),
		)
	})

	it("does not offer auto as though it were a release", () => {
		const offered: readonly string[] = MINECRAFT_VERSION_OPTIONS
		expect(offered).not.toContain(MINECRAFT_VERSION_AUTO)
	})
})

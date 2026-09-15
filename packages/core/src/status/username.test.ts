import type { InstanceConfigRow, InstanceRow } from "@open-mcc/db"
import type { HostReader } from "@open-mcc/transport"
import { LiveChannelUnavailableError } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { resolveMinecraftName } from "./username"

const instance = (overrides: Partial<InstanceRow> = {}): InstanceRow => ({
	id: "abc123",
	organizationId: "org-1",
	hostId: "host-1",
	name: "afk-1",
	accountType: "microsoft",
	liveControlPort: 33333,
	liveControlTokenEncrypted: "sealed",
	liveControlTokenKeyId: "key-1",
	minecraftAccount: "afk@example.com",
	minecraftUsername: null,
	status: "running",
	lastExitCode: null,
	authClaimId: null,
	authClaimedAt: null,
	playerListOffset: "0",
	playerListFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	playerListCursorVersion: "0",
	createdAt: new Date(),
	...overrides,
})

const LEGACY_DOCUMENT = {
	accountType: "microsoft",
	minecraftAccount: "afk@example.com",
	serverAddress: "play.example.net",
	autoRelogRetries: 3,
	autoRelogDelaySeconds: 10,
	antiAfkEnabled: false,
	antiAfkIntervalSeconds: 60,
	autoRespawnEnabled: false,
	liveControlEnabled: true,
	liveControlPort: 33333,
	worldDataEnabled: false,
	inventoryDataEnabled: false,
	entityDataEnabled: false,
	advancedKeys: {},
	botConfig: {},
}

const configRow = (document: InstanceConfigRow["document"]): InstanceConfigRow => ({
	id: "cfg-1",
	organizationId: "org-1",
	instanceId: "abc123",
	version: 1,
	document,
	authorId: null,
	authorLabel: "owner@example.com",
	createdAt: new Date(),
})

const spyReader = () => {
	const forwarded: number[] = []
	let released = 0
	const reader: HostReader = {
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		forward: async (port) => {
			forwarded.push(port)
			throw new LiveChannelUnavailableError("no channel in this test")
		},
		probePort: async () => "refused",
		release: () => {
			released += 1
		},
	}
	return { reader, forwarded, released: () => released }
}

describe("resolving the name an instance plays under", () => {
	it("reads a document written before delays were ranges and still consults the client", async () => {
		const { reader, forwarded, released } = spyReader()

		const name = await resolveMinecraftName(instance(), {
			latestConfig: async () => configRow(LEGACY_DOCUMENT),
			openToken: () => "token",
			reader: async () => reader,
		})

		expect(forwarded).toEqual([33333])
		expect(name).toBeUndefined()
		expect(released()).toBe(1)
	})

	it("does not consult the client when the operator left live control off", async () => {
		const { reader, forwarded } = spyReader()

		await resolveMinecraftName(instance(), {
			latestConfig: async () => configRow({ ...LEGACY_DOCUMENT, liveControlEnabled: false }),
			openToken: () => "token",
			reader: async () => reader,
		})

		expect(forwarded).toEqual([])
	})

	it("answers with the in-game name straight away for an offline account", async () => {
		const { reader, forwarded } = spyReader()

		const name = await resolveMinecraftName(
			instance({ accountType: "offline", minecraftAccount: "Steve" }),
			{
				latestConfig: async () => {
					throw new Error("the config should not be read for an offline account")
				},
				openToken: () => "token",
				reader: async () => reader,
			},
		)

		expect(name).toBe("Steve")
		expect(forwarded).toEqual([])
	})
})

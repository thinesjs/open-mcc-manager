import type { InstanceConfigRow, InstanceRow } from "@open-mcc/db"
import type { HostTransport } from "@open-mcc/transport"
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

const spyTransport = () => {
	const forwarded: number[] = []
	const transport: HostTransport = {
		state: () => "ready",
		connect: async () => undefined,
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		canForward: async () => true,
		forward: async (port) => {
			forwarded.push(port)
			throw new LiveChannelUnavailableError("no channel in this test")
		},
		close: async () => undefined,
	}
	return { transport, forwarded }
}

describe("resolving the name an instance plays under", () => {
	it("reads a document written before delays were ranges and still consults the client", async () => {
		const { transport, forwarded } = spyTransport()

		const name = await resolveMinecraftName(instance(), transport, {
			latestConfig: async () => configRow(LEGACY_DOCUMENT),
			openToken: () => "token",
		})

		expect(forwarded).toEqual([33333])
		expect(name).toBeUndefined()
	})

	it("does not consult the client when the operator left live control off", async () => {
		const { transport, forwarded } = spyTransport()

		await resolveMinecraftName(instance(), transport, {
			latestConfig: async () => configRow({ ...LEGACY_DOCUMENT, liveControlEnabled: false }),
			openToken: () => "token",
		})

		expect(forwarded).toEqual([])
	})

	it("answers with the in-game name straight away for an offline account", async () => {
		const { transport, forwarded } = spyTransport()

		const name = await resolveMinecraftName(
			instance({ accountType: "offline", minecraftAccount: "Steve" }),
			transport,
			{
				latestConfig: async () => {
					throw new Error("the config should not be read for an offline account")
				},
				openToken: () => "token",
			},
		)

		expect(name).toBe("Steve")
		expect(forwarded).toEqual([])
	})
})

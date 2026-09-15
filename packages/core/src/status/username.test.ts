import { createServer, type Server } from "node:http"
import { connect } from "node:net"
import type { InstanceConfigRow, InstanceRow } from "@open-mcc/db"
import type { HostReader } from "@open-mcc/transport"
import { LiveChannelUnavailableError, readCommandText } from "@open-mcc/transport"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
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

describe("asking a bot its name only while it runs", () => {
	const ACTIVE_CHECK =
		"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active --quiet 'open-mcc@abc123.service'"
	const authorizations: (string | undefined)[] = []
	let client: Server
	let clientPort = 0

	beforeAll(async () => {
		client = createServer((request, response) => {
			authorizations.push(request.headers.authorization)
			request.resume()
			request.on("end", () => response.writeHead(401).end())
		})
		await new Promise<void>((resolve) => client.listen(0, "127.0.0.1", resolve))
		const address = client.address()
		clientPort = address !== null && typeof address === "object" ? address.port : 0
	})

	afterAll(async () => {
		await new Promise<void>((resolve) => client.close(() => resolve()))
	})

	const leaseAnswering = (exitCode: number) => {
		const commands: string[] = []
		const forwarded: number[] = []
		let released = 0
		const reader: HostReader = {
			exec: async (command) => {
				commands.push(readCommandText(command))
				return { stdout: "", stderr: "", exitCode }
			},
			forward: async (port) => {
				forwarded.push(port)
				const socket = connect(clientPort, "127.0.0.1")
				return { socket, close: () => socket.destroy() }
			},
			probePort: async () => "refused",
			release: () => {
				released += 1
			},
		}
		return { reader, commands, forwarded, released: () => released }
	}

	const resolveOver = (reader: HostReader, row: InstanceRow) =>
		resolveMinecraftName(row, {
			latestConfig: async () => configRow(LEGACY_DOCUMENT),
			openToken: () => "31337token",
			reader: async () => reader,
		})

	it("opens no forward and sends no Authorization header to a bot whose unit is not active", async () => {
		authorizations.length = 0
		const stopped = leaseAnswering(3)

		expect(await resolveOver(stopped.reader, instance({ status: "stopped" }))).toBeUndefined()

		expect(stopped.commands).toEqual([ACTIVE_CHECK])
		expect(stopped.forwarded).toEqual([])
		expect(authorizations).toEqual([])
		expect(stopped.released()).toBe(1)
	})

	it("asks a bot whose unit is active, on the lease it asked on", async () => {
		authorizations.length = 0
		const running = leaseAnswering(0)

		await resolveOver(running.reader, instance())

		expect(running.commands).toEqual([ACTIVE_CHECK])
		expect(running.forwarded).toEqual([33333])
		expect(authorizations).toEqual(["Bearer 31337token"])
		expect(running.released()).toBe(1)
	})
})

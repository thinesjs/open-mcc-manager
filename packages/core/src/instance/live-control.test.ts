import { createServer, type Server } from "node:http"
import { connect } from "node:net"
import type { HostTransport } from "@open-mcc/transport"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { LIVE_CONTROL_ROUTE } from "./config"
import { readLoadedBots, readPlayerStats, readPlayersList, readStatusEffects } from "./live-control"

const PAYLOADS: Record<string, object> = {
	mcc_player_stats: {
		username: "AfkBot",
		playerEntityId: 7,
		location: { x: 1, y: 2, z: 3 },
		health: 20,
		saturation: 19,
		level: 5,
		totalExperience: 60,
		gamemode: 0,
		currentSlot: 3,
		yaw: 90,
		pitch: -10,
		tps: 19.5,
	},
	mcc_status_effects: {
		count: 1,
		effects: [
			{
				id: "Regeneration",
				name: "Regeneration",
				amplifier: 2,
				remainingSeconds: 17,
				isInfinite: false,
			},
		],
	},
	mcc_loaded_bots: {
		count: 1,
		bots: [{ name: "AntiAfk", fullTypeName: "MinecraftClient.ChatBots.AntiAfk", isScript: false }],
	},
	mcc_players_list: { players: ["Steve"] },
}

const calledTools: string[] = []
const refusedTools = new Set<string>()

let server: Server
let servedPort = 0

const readBody = async (stream: AsyncIterable<Buffer>): Promise<string> => {
	const chunks: Buffer[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return Buffer.concat(chunks).toString("utf8")
}

beforeAll(async () => {
	server = createServer((request, response) => {
		void readBody(request).then((text) => {
			const message = JSON.parse(text)
			if (message.method === "initialize") {
				response.writeHead(200, { "content-type": "application/json" })
				response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }))
				return
			}
			if (message.method !== "tools/call") {
				response.writeHead(202).end()
				return
			}
			const tool = message.params.name
			calledTools.push(tool)
			const envelope = refusedTools.has(tool)
				? { success: false, error: "the client refused" }
				: { success: true, data: PAYLOADS[tool] }
			response.writeHead(200, { "content-type": "application/json" })
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					result: { structuredContent: envelope, content: [] },
				}),
			)
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	servedPort = address !== null && typeof address === "object" ? address.port : 0
})

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()))
})

const transport: HostTransport = {
	state: () => "ready",
	connect: async () => undefined,
	exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	canForward: async () => true,
	forward: async () => {
		const socket = connect(servedPort, "127.0.0.1")
		return { socket, close: () => socket.destroy() }
	},
	close: async () => undefined,
}

const target = () => ({ transport, port: servedPort, route: LIVE_CONTROL_ROUTE, token: "t" })

describe("reading the four live readouts over a real channel", () => {
	it("asks the client for the player stats by name and normalises the answer", async () => {
		calledTools.length = 0

		const stats = await readPlayerStats(target())

		expect(calledTools).toEqual(["mcc_player_stats"])
		expect(stats).toEqual({
			health: 20,
			foodLevel: 19,
			level: 5,
			totalExperience: 60,
			gamemode: 0,
			currentSlot: 3,
			yaw: 90,
			pitch: -10,
			tps: 19.5,
		})
	})

	it("asks the client for the status effects by name and normalises the answer", async () => {
		calledTools.length = 0

		const effects = await readStatusEffects(target())

		expect(calledTools).toEqual(["mcc_status_effects"])
		expect(effects).toEqual([
			{ id: "Regeneration", amplifier: 2, remainingSeconds: 17, isInfinite: false },
		])
	})

	it("asks the client for the loaded bots by name and normalises the answer", async () => {
		calledTools.length = 0

		const bots = await readLoadedBots(target())

		expect(calledTools).toEqual(["mcc_loaded_bots"])
		expect(bots).toEqual([{ name: "AntiAfk", isScript: false }])
	})

	it("asks the client for the players by name and normalises the answer", async () => {
		calledTools.length = 0

		const players = await readPlayersList(target())

		expect(calledTools).toEqual(["mcc_players_list"])
		expect(players).toEqual(["Steve"])
	})
})

describe("one refused readout leaves the others alone", () => {
	it.each([
		{ named: "the player stats", tool: "mcc_player_stats" },
		{ named: "the status effects", tool: "mcc_status_effects" },
		{ named: "the loaded bots", tool: "mcc_loaded_bots" },
		{ named: "the players list", tool: "mcc_players_list" },
	])("still answers the other three when $named is refused", async ({ tool }) => {
		refusedTools.clear()
		refusedTools.add(tool)

		const outcomes = await Promise.allSettled([
			readPlayerStats(target()),
			readStatusEffects(target()),
			readLoadedBots(target()),
			readPlayersList(target()),
		])
		refusedTools.clear()

		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1)
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(3)
	})
})

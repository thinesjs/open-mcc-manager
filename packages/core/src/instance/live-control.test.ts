import { createServer, type Server } from "node:http"
import { connect } from "node:net"
import type { HostReader } from "@open-mcc/transport"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { LIVE_CONTROL_ROUTE } from "./config"
import {
	type LiveControlTarget,
	type LiveReadTarget,
	probeListening,
	READ_TOOLS,
	type ReadToolName,
	readLoadedBots,
	readPlayerStats,
	readPlayersList,
	readStatusEffects,
	WRITE_TOOLS,
	type WriteToolName,
} from "./live-control"

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

const reader: HostReader = {
	exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	forward: async () => {
		const socket = connect(servedPort, "127.0.0.1")
		return { socket, close: () => socket.destroy() }
	},
	release: () => undefined,
}

const target = (): LiveReadTarget => ({
	reader,
	port: servedPort,
	route: LIVE_CONTROL_ROUTE,
	token: "t",
})

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

type Assignable<From, To> = [From] extends [To] ? true : false

describe("T17: the read side cannot name a write, checked by the compiler", () => {
	const dropIsNotARead: Assignable<"mcc_inventory_drop_item", ReadToolName> = false
	const selectIsNotARead: Assignable<"mcc_select_item", ReadToolName> = false
	const noWriteIsARead: Assignable<WriteToolName, ReadToolName> = false
	const aReadTargetIsNotAWriteTarget: Assignable<LiveReadTarget, LiveControlTarget> = false
	const aReaderIsNotAWriteTransport: Assignable<HostReader, LiveControlTarget["transport"]> = false

	it("keeps both inventory writes, and the transport they need, off the read side", () => {
		expect([
			dropIsNotARead,
			selectIsNotARead,
			noWriteIsARead,
			aReadTargetIsNotAWriteTarget,
			aReaderIsNotAWriteTransport,
		]).toEqual([false, false, false, false, false])
		const readable = new Set<string>(READ_TOOLS)
		expect(WRITE_TOOLS.filter((write) => readable.has(write))).toEqual([])
	})
})

describe("checking that a client listens without saying who is asking", () => {
	const seen: {
		method: string | undefined
		url: string | undefined
		authorization: string | undefined
	}[] = []
	const answer = { status: 401 }
	let probed: Server
	let probedPort = 0

	beforeAll(async () => {
		probed = createServer((request, response) => {
			seen.push({
				method: request.method,
				url: request.url,
				authorization: request.headers.authorization,
			})
			request.resume()
			request.on("end", () => response.writeHead(answer.status).end("Unauthorized"))
		})
		await new Promise<void>((resolve) => probed.listen(0, "127.0.0.1", resolve))
		const address = probed.address()
		probedPort = address !== null && typeof address === "object" ? address.port : 0
	})

	afterAll(async () => {
		await new Promise<void>((resolve) => probed.close(() => resolve()))
	})

	const probeTarget = () => ({
		reader: {
			forward: async () => {
				const socket = connect(probedPort, "127.0.0.1")
				return { socket, close: () => socket.destroy() }
			},
		},
		port: probedPort,
		route: LIVE_CONTROL_ROUTE,
	})

	it("sends one request with no Authorization header, and takes a 401 as listening", async () => {
		seen.length = 0
		answer.status = 401

		expect(await probeListening(probeTarget())).toBe(true)
		expect(seen).toEqual([{ method: "POST", url: LIVE_CONTROL_ROUTE, authorization: undefined }])
	})

	it("takes no other answer as listening", async () => {
		answer.status = 200

		expect(await probeListening(probeTarget())).toBe(false)
	})
})

import { request as httpRequest } from "node:http"
import {
	callToolRequest,
	chatHistoryFrom,
	entityListFrom,
	initializedNotification,
	initializeRequest,
	inventoryActionFrom,
	inventoryFrom,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	MCP_SESSION_HEADER,
	type McpChatEntry,
	type McpEntityList,
	type McpEventPage,
	type McpInventory,
	type McpSessionStatus,
	type McpWorldState,
	PLAYER_INVENTORY_ID,
	recentEventsFrom,
	responseFrom,
	sessionStatusFrom,
	worldStateFrom,
} from "@open-mcc/contracts/boundary/mcp"
import {
	loadedBotsFrom,
	type McpLoadedBot,
	type McpPlayerStats,
	type McpStatusEffect,
	playerStatsFrom,
	playersListFrom,
	statusEffectsFrom,
} from "@open-mcc/contracts/boundary/mcp-readouts"
import {
	type ForwardedStream,
	type HostReader,
	type HostTransport,
	LiveChannelUnavailableError,
	TransportInterruptedError,
} from "@open-mcc/transport"

export const LIVE_CONTROL_TIMEOUT_MS = 10_000

export const LIVE_CONTROL_CLIENT = "open-mcc-manager"

export const MAX_LIVE_RESPONSE_BYTES = 1024 * 1024

export class LiveResponseTooLargeError extends Error {}

export const READ_TOOLS = [
	"mcc_session_status",
	"mcc_chat_history",
	"mcc_recent_events",
	"mcc_world_state",
	"mcc_player_stats",
	"mcc_status_effects",
	"mcc_loaded_bots",
	"mcc_players_list",
	"mcc_entities_list",
	"mcc_inventory_snapshot",
] as const

export type ReadToolName = (typeof READ_TOOLS)[number]

export const WRITE_TOOLS = ["mcc_inventory_drop_item", "mcc_select_item"] as const

export type WriteToolName = (typeof WRITE_TOOLS)[number]

type LiveRoute = {
	port: number
	route: string
}

type LiveEndpoint = LiveRoute & { token: string }

export type LiveControlTarget = LiveEndpoint & { transport: HostTransport }

export type LiveReadTarget = LiveEndpoint & { reader: HostReader }

export type LiveProbeTarget = LiveRoute & { reader: Pick<HostReader, "forward"> }

type LiveChannels = {
	open: (port: number) => Promise<ForwardedStream>
	answerWithinMs: number | undefined
}

type HttpReply = { status: number; body: string; sessionId: string | undefined }

const unavailable = (error: Error): Error =>
	error instanceof TransportInterruptedError
		? error
		: new LiveChannelUnavailableError(error.message)

const post = async (
	channels: LiveChannels,
	endpoint: LiveRoute,
	body: string,
	extraHeaders: Record<string, string>,
): Promise<HttpReply> => {
	const channel = await channels.open(endpoint.port)
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		"content-length": String(Buffer.byteLength(body)),
		host: `127.0.0.1:${endpoint.port}`,
		...extraHeaders,
	}

	return await new Promise<HttpReply>((resolve, reject) => {
		let settled = false
		const finish = (outcome: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			channel.close()
			outcome()
		}
		const timer =
			channels.answerWithinMs === undefined
				? undefined
				: setTimeout(
						() =>
							finish(() => reject(new LiveChannelUnavailableError("The client did not answer"))),
						channels.answerWithinMs,
					)
		channel.socket.on("error", (error: Error) => finish(() => reject(unavailable(error))))
		const call = httpRequest(
			{
				createConnection: () => channel.socket,
				method: "POST",
				path: endpoint.route,
				headers,
			},
			(response) => {
				const chunks: Buffer[] = []
				let received = 0
				response.on("data", (chunk: Buffer) => {
					received += chunk.length
					if (received > MAX_LIVE_RESPONSE_BYTES) {
						response.destroy()
						finish(() =>
							reject(
								new LiveResponseTooLargeError(
									`The client sent more than ${MAX_LIVE_RESPONSE_BYTES} bytes in one response`,
								),
							),
						)
						return
					}
					chunks.push(chunk)
				})
				response.on("end", () =>
					finish(() =>
						resolve({
							status: response.statusCode ?? 0,
							body: Buffer.concat(chunks).toString("utf8"),
							sessionId: readSessionHeader(response.headers[MCP_SESSION_HEADER]),
						}),
					),
				)
				response.on("error", (error: Error) => finish(() => reject(unavailable(error))))
			},
		)
		call.on("error", (error: Error) => finish(() => reject(unavailable(error))))
		call.end(body)
	})
}

const readSessionHeader = (value: string | string[] | undefined): string | undefined =>
	Array.isArray(value) ? value[0] : value

const rpc = (
	channels: LiveChannels,
	endpoint: LiveEndpoint,
	payload: JsonRpcRequest | JsonRpcNotification,
	sessionId: string | undefined,
): Promise<HttpReply> =>
	post(channels, endpoint, JSON.stringify(payload), {
		authorization: `Bearer ${endpoint.token}`,
		...(sessionId === undefined ? {} : { [MCP_SESSION_HEADER]: sessionId }),
	})

export const probeListening = async (target: LiveProbeTarget): Promise<boolean> => {
	try {
		const reply = await post(
			{ open: (port) => target.reader.forward(port), answerWithinMs: LIVE_CONTROL_TIMEOUT_MS },
			target,
			"",
			{},
		)
		return reply.status === 401
	} catch (error) {
		if (error instanceof TransportInterruptedError) throw error
		return false
	}
}

export class LiveControlUnauthorizedError extends Error {}

const ensureAccepted = (reply: HttpReply): void => {
	if (reply.status === 401 || reply.status === 403) {
		throw new LiveControlUnauthorizedError("The client rejected this manager's token")
	}
	if (reply.status >= 400) {
		throw new LiveChannelUnavailableError(`The client answered ${reply.status}`)
	}
}

export type ToolArguments = Record<string, string | number | boolean>

const callTool = async <T>(
	channels: LiveChannels,
	endpoint: LiveEndpoint,
	tool: ReadToolName | WriteToolName,
	read: (response: JsonRpcResponse) => T,
	args: ToolArguments,
): Promise<T> => {
	const handshake = await rpc(
		channels,
		endpoint,
		initializeRequest(1, LIVE_CONTROL_CLIENT),
		undefined,
	)
	ensureAccepted(handshake)
	responseFrom(handshake.body)

	const session = handshake.sessionId
	await rpc(channels, endpoint, initializedNotification(), session)

	const reply = await rpc(channels, endpoint, callToolRequest(2, tool, args), session)
	ensureAccepted(reply)
	return read(responseFrom(reply.body))
}

export const callLiveTool = <T>(
	target: LiveControlTarget,
	tool: WriteToolName,
	read: (response: JsonRpcResponse) => T,
	args: ToolArguments = {},
	timeoutMs: number = LIVE_CONTROL_TIMEOUT_MS,
): Promise<T> =>
	callTool(
		{ open: (port) => target.transport.forward(port, timeoutMs), answerWithinMs: timeoutMs },
		target,
		tool,
		read,
		args,
	)

export const callReadTool = <T>(
	target: LiveReadTarget,
	tool: ReadToolName,
	read: (response: JsonRpcResponse) => T,
	args: ToolArguments = {},
): Promise<T> =>
	callTool(
		{ open: (port) => target.reader.forward(port), answerWithinMs: undefined },
		target,
		tool,
		read,
		args,
	)

export const readSessionStatus = (target: LiveReadTarget): Promise<McpSessionStatus> =>
	callReadTool(target, "mcc_session_status", sessionStatusFrom)

export const LIVE_CHAT_MAX_LINES = 200

export const readChatHistory = (
	target: LiveReadTarget,
	maxCount: number = LIVE_CHAT_MAX_LINES,
): Promise<McpChatEntry[]> =>
	callReadTool(target, "mcc_chat_history", chatHistoryFrom, { maxCount, includeJson: true })

export const LIVE_EVENT_MAX = 50

export const readRecentEvents = (
	target: LiveReadTarget,
	afterId = 0,
	maxCount: number = LIVE_EVENT_MAX,
): Promise<McpEventPage> =>
	callReadTool(target, "mcc_recent_events", recentEventsFrom, { afterId, maxCount })

export const readWorldState = (target: LiveReadTarget): Promise<McpWorldState> =>
	callReadTool(target, "mcc_world_state", worldStateFrom)

export const readPlayerStats = (target: LiveReadTarget): Promise<McpPlayerStats> =>
	callReadTool(target, "mcc_player_stats", playerStatsFrom)

export const readStatusEffects = (target: LiveReadTarget): Promise<McpStatusEffect[]> =>
	callReadTool(target, "mcc_status_effects", statusEffectsFrom)

export const readLoadedBots = (target: LiveReadTarget): Promise<McpLoadedBot[]> =>
	callReadTool(target, "mcc_loaded_bots", loadedBotsFrom)

export const readPlayersList = (target: LiveReadTarget): Promise<string[]> =>
	callReadTool(target, "mcc_players_list", playersListFrom)

export const LIVE_ENTITY_MAX = 25

export const LIVE_ENTITY_RADIUS = 32

export const readEntities = (target: LiveReadTarget): Promise<McpEntityList> =>
	callReadTool(target, "mcc_entities_list", entityListFrom, {
		maxCount: LIVE_ENTITY_MAX,
		radius: LIVE_ENTITY_RADIUS,
	})

export const readInventory = (target: LiveReadTarget): Promise<McpInventory> =>
	callReadTool(target, "mcc_inventory_snapshot", inventoryFrom, {
		inventoryId: PLAYER_INVENTORY_ID,
	})

export const dropInventoryItem = (
	target: LiveControlTarget,
	itemType: string,
	count: number,
	timeoutMs: number = LIVE_CONTROL_TIMEOUT_MS,
): Promise<void> =>
	callLiveTool(
		target,
		"mcc_inventory_drop_item",
		inventoryActionFrom,
		{ itemType, count, inventoryId: PLAYER_INVENTORY_ID },
		timeoutMs,
	)

export const selectHeldItem = (
	target: LiveControlTarget,
	itemType: string,
	timeoutMs: number = LIVE_CONTROL_TIMEOUT_MS,
): Promise<void> =>
	callLiveTool(target, "mcc_select_item", inventoryActionFrom, { itemType }, timeoutMs)

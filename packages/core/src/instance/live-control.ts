import { request as httpRequest } from "node:http"
import {
	callToolRequest,
	chatHistoryFrom,
	initializedNotification,
	initializeRequest,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	MCP_SESSION_HEADER,
	type McpChatEntry,
	type McpEventPage,
	type McpSessionStatus,
	recentEventsFrom,
	responseFrom,
	sessionStatusFrom,
} from "@open-mcc/contracts/boundary/mcp"
import type { HostTransport } from "@open-mcc/transport"
import { LiveChannelUnavailableError } from "@open-mcc/transport"

export const LIVE_CONTROL_TIMEOUT_MS = 10_000

export const LIVE_CONTROL_CLIENT = "open-mcc-manager"

export type LiveControlTarget = {
	transport: HostTransport
	port: number
	route: string
	token: string
}

type HttpReply = { status: number; body: string; sessionId: string | undefined }

const post = async (
	target: LiveControlTarget,
	payload: JsonRpcRequest | JsonRpcNotification,
	sessionId: string | undefined,
	timeoutMs: number,
): Promise<HttpReply> => {
	const channel = await target.transport.forward(target.port, timeoutMs)
	const body = JSON.stringify(payload)
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		authorization: `Bearer ${target.token}`,
		"content-length": String(Buffer.byteLength(body)),
		host: `127.0.0.1:${target.port}`,
	}
	if (sessionId !== undefined) headers[MCP_SESSION_HEADER] = sessionId

	return await new Promise<HttpReply>((resolve, reject) => {
		let settled = false
		const finish = (outcome: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			channel.close()
			outcome()
		}
		const timer = setTimeout(
			() => finish(() => reject(new LiveChannelUnavailableError("The client did not answer"))),
			timeoutMs,
		)
		const call = httpRequest(
			{
				createConnection: () => channel.socket,
				method: "POST",
				path: target.route,
				headers,
			},
			(response) => {
				const chunks: Buffer[] = []
				response.on("data", (chunk: Buffer) => chunks.push(chunk))
				response.on("end", () =>
					finish(() =>
						resolve({
							status: response.statusCode ?? 0,
							body: Buffer.concat(chunks).toString("utf8"),
							sessionId: readSessionHeader(response.headers[MCP_SESSION_HEADER]),
						}),
					),
				)
				response.on("error", (error: Error) =>
					finish(() => reject(new LiveChannelUnavailableError(error.message))),
				)
			},
		)
		call.on("error", (error: Error) =>
			finish(() => reject(new LiveChannelUnavailableError(error.message))),
		)
		call.end(body)
	})
}

const readSessionHeader = (value: string | string[] | undefined): string | undefined =>
	Array.isArray(value) ? value[0] : value

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

export const callLiveTool = async <T>(
	target: LiveControlTarget,
	tool: string,
	read: (response: JsonRpcResponse) => T,
	args: ToolArguments = {},
	timeoutMs: number = LIVE_CONTROL_TIMEOUT_MS,
): Promise<T> => {
	const handshake = await post(
		target,
		initializeRequest(1, LIVE_CONTROL_CLIENT),
		undefined,
		timeoutMs,
	)
	ensureAccepted(handshake)
	responseFrom(handshake.body)

	const session = handshake.sessionId
	await post(target, initializedNotification(), session, timeoutMs)

	const reply = await post(target, callToolRequest(2, tool, args), session, timeoutMs)
	ensureAccepted(reply)
	return read(responseFrom(reply.body))
}

export const readSessionStatus = (
	target: LiveControlTarget,
	timeoutMs: number = LIVE_CONTROL_TIMEOUT_MS,
): Promise<McpSessionStatus> =>
	callLiveTool(target, "mcc_session_status", sessionStatusFrom, {}, timeoutMs)

export const LIVE_CHAT_MAX_LINES = 200

export const readChatHistory = (
	target: LiveControlTarget,
	maxCount: number = LIVE_CHAT_MAX_LINES,
	timeoutMs: number = LIVE_CONTROL_TIMEOUT_MS,
): Promise<McpChatEntry[]> =>
	callLiveTool(
		target,
		"mcc_chat_history",
		chatHistoryFrom,
		{ maxCount, includeJson: true },
		timeoutMs,
	)

export const LIVE_EVENT_MAX = 50

export const readRecentEvents = (
	target: LiveControlTarget,
	afterId = 0,
	maxCount: number = LIVE_EVENT_MAX,
	timeoutMs: number = LIVE_CONTROL_TIMEOUT_MS,
): Promise<McpEventPage> =>
	callLiveTool(target, "mcc_recent_events", recentEventsFrom, { afterId, maxCount }, timeoutMs)

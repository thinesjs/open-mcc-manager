import { z } from "zod"

export const MCP_PROTOCOL_VERSION = "2025-06-18"

export const MCP_SESSION_HEADER = "mcp-session-id"

export type JsonRpcRequest = {
	jsonrpc: "2.0"
	id: number
	method: string
	params: Record<string, unknown>
}

export type JsonRpcNotification = {
	jsonrpc: "2.0"
	method: string
	params: Record<string, unknown>
}

export const initializeRequest = (id: number, clientName: string): JsonRpcRequest => ({
	jsonrpc: "2.0",
	id,
	method: "initialize",
	params: {
		protocolVersion: MCP_PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: { name: clientName, version: "1" },
	},
})

export const initializedNotification = (): JsonRpcNotification => ({
	jsonrpc: "2.0",
	method: "notifications/initialized",
	params: {},
})

export const callToolRequest = (
	id: number,
	name: string,
	args: Record<string, string | number | boolean>,
): JsonRpcRequest => ({
	jsonrpc: "2.0",
	id,
	method: "tools/call",
	params: { name, arguments: args },
})

const jsonRpcError = z.object({
	code: z.number(),
	message: z.string(),
})

const jsonRpcResponse = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.union([z.number(), z.string()]).nullable().optional(),
	result: z.unknown().optional(),
	error: jsonRpcError.optional(),
})

export type JsonRpcResponse = z.infer<typeof jsonRpcResponse>

export const dataFramesOf = (body: string): string[] => {
	const trimmed = body.trim()
	if (trimmed.length === 0) return []
	if (!trimmed.includes("\ndata:") && !trimmed.startsWith("data:")) return [trimmed]
	const frames: string[] = []
	for (const block of trimmed.split(/\n\n+/)) {
		const payload = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
		if (payload.length > 0) frames.push(payload)
	}
	return frames
}

export class McpProtocolError extends Error {}

export const responseFrom = (body: string): JsonRpcResponse => {
	const frames = dataFramesOf(body)
	if (frames.length === 0) throw new McpProtocolError("The client returned an empty response")
	const last = frames[frames.length - 1] ?? ""
	let parsed: unknown
	try {
		parsed = JSON.parse(last)
	} catch {
		throw new McpProtocolError("The client returned a response that is not JSON")
	}
	const result = jsonRpcResponse.safeParse(parsed)
	if (!result.success) throw new McpProtocolError("The client returned a malformed response")
	if (result.data.error) {
		throw new McpProtocolError(`${result.data.error.message} (${result.data.error.code})`)
	}
	return result.data
}

const toolContent = z.object({
	content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
	structuredContent: z.unknown().optional(),
	isError: z.boolean().optional(),
})

const mccEnvelope = z.object({
	success: z.boolean(),
	data: z.unknown().optional(),
	error: z.string().optional(),
	errorCode: z.string().optional(),
})

const unwrapEnvelope = (value: unknown): unknown => {
	const parsed = mccEnvelope.safeParse(value)
	if (!parsed.success) return value
	if (!parsed.data.success) {
		throw new McpProtocolError(
			parsed.data.errorCode ?? parsed.data.error ?? "The client refused the call",
		)
	}
	return parsed.data.data
}

export const toolResultOf = (response: JsonRpcResponse): unknown => {
	const parsed = toolContent.safeParse(response.result)
	if (!parsed.success) return response.result
	if (parsed.data.isError === true) {
		const text = parsed.data.content?.find((part) => part.text !== undefined)?.text
		throw new McpProtocolError(text ?? "The client refused the call")
	}
	if (parsed.data.structuredContent !== undefined) {
		return unwrapEnvelope(parsed.data.structuredContent)
	}
	const text = parsed.data.content?.find((part) => part.text !== undefined)?.text
	if (text === undefined) return parsed.data
	try {
		return unwrapEnvelope(JSON.parse(text))
	} catch (error) {
		if (error instanceof McpProtocolError) throw error
		return text
	}
}

export const mcpSessionStatusSchema = z.object({
	host: z.string(),
	port: z.number(),
	username: z.string(),
	protocolVersion: z.number(),
	terrainEnabled: z.boolean(),
	inventoryEnabled: z.boolean(),
	entityEnabled: z.boolean(),
	location: z
		.object({ x: z.number(), y: z.number(), z: z.number() })
		.partial()
		.nullable()
		.optional(),
})

export type McpSessionStatus = z.infer<typeof mcpSessionStatusSchema>

export const sessionStatusFrom = (response: JsonRpcResponse): McpSessionStatus => {
	const parsed = mcpSessionStatusSchema.safeParse(toolResultOf(response))
	if (!parsed.success) {
		throw new McpProtocolError("The client reported a session status this manager cannot read")
	}
	return parsed.data
}

export const CHAT_KINDS = ["chat", "private", "system"] as const

export const chatKindSchema = z.enum(CHAT_KINDS)

export type ChatKind = z.infer<typeof chatKindSchema>

const chatEntrySchema = z.object({
	timestampUtc: z.string(),
	kind: z.string(),
	text: z.string(),
	sender: z.string().nullable().optional(),
	message: z.string().nullable().optional(),
	json: z.string().nullable().optional(),
})

const chatHistorySchema = z.object({
	count: z.number(),
	entries: z.array(chatEntrySchema),
})

export type McpChatEntry = {
	timestampUtc: string
	kind: ChatKind
	text: string
	sender: string | undefined
	message: string | undefined
	json: string | undefined
}

const asChatKind = (value: string): ChatKind => {
	const parsed = chatKindSchema.safeParse(value)
	return parsed.success ? parsed.data : "system"
}

const orUndefined = (value: string | null | undefined): string | undefined =>
	value === null || value === undefined || value.length === 0 ? undefined : value

export const chatHistoryFrom = (response: JsonRpcResponse): McpChatEntry[] => {
	const parsed = chatHistorySchema.safeParse(toolResultOf(response))
	if (!parsed.success) {
		throw new McpProtocolError("The client reported a chat history this manager cannot read")
	}
	return parsed.data.entries.map((entry) => ({
		timestampUtc: entry.timestampUtc,
		kind: asChatKind(entry.kind),
		text: entry.text,
		sender: orUndefined(entry.sender),
		message: orUndefined(entry.message),
		json: orUndefined(entry.json),
	}))
}

export const NOISY_EVENT_TYPES = [
	"block_break_animation",
	"entity_animation",
	"actionbar",
	"title",
	"inventory_open",
	"inventory_close",
] as const

const noisy: ReadonlySet<string> = new Set(NOISY_EVENT_TYPES)

export const isNotableEvent = (type: string): boolean => !noisy.has(type)

const recentEventSchema = z.object({
	id: z.number(),
	timestampUtc: z.string(),
	type: z.string(),
	data: z.unknown().optional(),
})

const recentEventsSchema = z.object({
	afterId: z.number(),
	latestId: z.number(),
	count: z.number(),
	events: z.array(recentEventSchema),
})

export type McpEvent = {
	id: number
	timestampUtc: string
	type: string
	subject: string | undefined
}

export type McpEventPage = {
	latestId: number
	events: McpEvent[]
}

const eventSubject = z.object({
	name: z.string().optional(),
	reason: z.string().optional(),
	level: z.number().optional(),
})

const subjectOf = (data: unknown): string | undefined => {
	const parsed = eventSubject.safeParse(data)
	if (!parsed.success) return undefined
	if (parsed.data.name !== undefined) return parsed.data.name
	if (parsed.data.reason !== undefined) return parsed.data.reason
	if (parsed.data.level !== undefined) return String(parsed.data.level)
	return undefined
}

export const recentEventsFrom = (response: JsonRpcResponse): McpEventPage => {
	const parsed = recentEventsSchema.safeParse(toolResultOf(response))
	if (!parsed.success) {
		throw new McpProtocolError("The client reported events this manager cannot read")
	}
	return {
		latestId: parsed.data.latestId,
		events: parsed.data.events
			.filter((event) => isNotableEvent(event.type))
			.map((event) => ({
				id: event.id,
				timestampUtc: event.timestampUtc,
				type: event.type,
				subject: subjectOf(event.data),
			})),
	}
}

export const mcpWorldStateSchema = z.object({
	tps: z.number().optional(),
	dimension: z.string().optional(),
	loadedChunkCount: z.number().optional(),
	pendingChunkCount: z.number().optional(),
	totalChunkCount: z.number().optional(),
	terrainEnabled: z.boolean().optional(),
	location: z
		.object({ x: z.number().optional(), y: z.number().optional(), z: z.number().optional() })
		.nullable()
		.optional(),
})

export type McpWorldState = z.infer<typeof mcpWorldStateSchema>

export const worldStateFrom = (response: JsonRpcResponse): McpWorldState => {
	const parsed = mcpWorldStateSchema.safeParse(toolResultOf(response))
	if (!parsed.success) {
		throw new McpProtocolError("The client reported a world state this manager cannot read")
	}
	return parsed.data
}

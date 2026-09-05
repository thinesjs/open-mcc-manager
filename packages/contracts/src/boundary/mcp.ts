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

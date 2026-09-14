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

export const MCC_REFUSALS = [
	"capability_disabled",
	"feature_disabled",
	"disconnected",
	"invalid_args",
	"invalid_state",
	"action_failed",
] as const

export const mccRefusalSchema = z.enum(MCC_REFUSALS)

export type MccRefusal = z.infer<typeof mccRefusalSchema>

export class McpRefusalError extends Error {
	readonly refusal: MccRefusal

	constructor(refusal: MccRefusal) {
		super(`The client refused the call: ${refusal}`)
		this.refusal = refusal
	}
}

const unwrapEnvelope = (value: unknown): unknown => {
	const parsed = mccEnvelope.safeParse(value)
	if (!parsed.success) return value
	if (!parsed.data.success) {
		const refusal = mccRefusalSchema.safeParse(parsed.data.errorCode)
		if (refusal.success) throw new McpRefusalError(refusal.data)
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
	let json: unknown
	try {
		json = JSON.parse(text)
	} catch {
		return text
	}
	return unwrapEnvelope(json)
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

const EMPTY_SENDER = "<> "

const withoutEmptySender = (text: string): string =>
	text.startsWith(EMPTY_SENDER) ? text.slice(EMPTY_SENDER.length) : text

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
		text: withoutEmptySender(entry.text),
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

const mcpEntitySchema = z.object({
	id: z.number(),
	type: z.string().optional(),
	typeLabel: z.string().optional(),
	distance: z.number().optional(),
	health: z.number().optional(),
	name: z.string().nullable().optional(),
})

const mcpEntityListSchema = z.object({
	totalTracked: z.number().optional(),
	count: z.number().optional(),
	entities: z.array(mcpEntitySchema),
})

export type McpEntity = {
	id: number
	label: string
	distance: number | undefined
	health: number | undefined
}

export type McpEntityList = {
	totalTracked: number
	entities: McpEntity[]
}

export const entityListFrom = (response: JsonRpcResponse): McpEntityList => {
	const parsed = mcpEntityListSchema.safeParse(toolResultOf(response))
	if (!parsed.success) {
		throw new McpProtocolError("The client reported entities this manager cannot read")
	}
	return {
		totalTracked: parsed.data.totalTracked ?? parsed.data.entities.length,
		entities: parsed.data.entities.map((entity) => ({
			id: entity.id,
			label: entity.name ?? entity.typeLabel ?? entity.type ?? "unknown",
			distance: entity.distance,
			health: entity.health,
		})),
	}
}

export const PLAYER_INVENTORY_ID = 0

const mcpItemStackSchema = z.object({
	type: z.string(),
	count: z.number(),
})

const mcpInventorySlotSchema = z.object({
	slot: z.number(),
	type: z.string(),
	count: z.number(),
})

const mcpInventorySchema = z.object({
	id: z.number(),
	type: z.string().optional(),
	title: z.string().optional(),
	slotCount: z.number().optional(),
	slots: z.array(mcpInventorySlotSchema),
	cursor: mcpItemStackSchema.nullable().optional(),
})

export type McpItemStack = {
	label: string
	count: number
}

export type McpInventorySlot = {
	slot: number
	type: string
	label: string
	count: number
}

export type McpInventory = {
	id: number
	title: string | undefined
	slotCount: number
	slots: McpInventorySlot[]
	cursor: McpItemStack | undefined
}

export const itemSlug = (value: string): string =>
	value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[\s-]+/g, "_")
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, "")

export const humanizeItemType = (value: string): string => {
	const spaced = value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/_/g, " ")
		.trim()
	return spaced.length === 0 ? value : spaced
}

const trimmedOrUndefined = (value: string | undefined): string | undefined => {
	if (value === undefined) return undefined
	const trimmed = value.trim()
	return trimmed.length === 0 ? undefined : trimmed
}

export const inventoryFrom = (response: JsonRpcResponse): McpInventory => {
	const parsed = mcpInventorySchema.safeParse(toolResultOf(response))
	if (!parsed.success) {
		throw new McpProtocolError("The client reported an inventory this manager cannot read")
	}
	const slots = parsed.data.slots
		.filter((slot) => slot.count > 0)
		.map((slot) => ({
			slot: slot.slot,
			type: slot.type,
			label: humanizeItemType(slot.type),
			count: slot.count,
		}))
		.sort((left, right) => left.slot - right.slot)
	const cursor = parsed.data.cursor
	return {
		id: parsed.data.id,
		title: trimmedOrUndefined(parsed.data.title),
		slotCount: parsed.data.slotCount ?? 0,
		slots,
		cursor:
			cursor === null || cursor === undefined
				? undefined
				: { label: humanizeItemType(cursor.type), count: cursor.count },
	}
}

export type McpInventoryRegion = {
	name: string
	slots: number[]
	columns: number
}

const slotRange = (from: number, to: number): number[] =>
	Array.from({ length: to - from + 1 }, (_, index) => from + index)

export const PLAYER_INVENTORY_REGIONS: McpInventoryRegion[] = [
	{ name: "Armour", slots: slotRange(5, 8), columns: 4 },
	{ name: "Offhand", slots: [45], columns: 1 },
	{ name: "Crafting", slots: slotRange(1, 4), columns: 2 },
	{ name: "Inventory", slots: slotRange(9, 35), columns: 9 },
	{ name: "Hotbar", slots: slotRange(36, 44), columns: 9 },
]

export const regionsFor = (inventory: { id: number; slotCount: number }): McpInventoryRegion[] =>
	inventory.id === PLAYER_INVENTORY_ID
		? PLAYER_INVENTORY_REGIONS
		: [{ name: "Contents", slots: slotRange(0, inventory.slotCount - 1), columns: 9 }]

export const slotsBySlotNumber = (
	slots: readonly McpInventorySlot[],
): Map<number, McpInventorySlot> => new Map(slots.map((slot) => [slot.slot, slot]))

export const inventoryItemTotal = (inventory: { slots: readonly McpInventorySlot[] }): number =>
	inventory.slots.reduce((total, slot) => total + slot.count, 0)

export const inventoryActionFrom = (response: JsonRpcResponse): void => {
	toolResultOf(response)
}

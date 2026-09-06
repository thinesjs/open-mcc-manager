import { describe, expect, it } from "vitest"
import {
	callToolRequest,
	chatHistoryFrom,
	dataFramesOf,
	entityListFrom,
	initializeRequest,
	isNotableEvent,
	McpProtocolError,
	recentEventsFrom,
	responseFrom,
	sessionStatusFrom,
	toolResultOf,
} from "./mcp"

describe("mcp wire format", () => {
	it("reads a plain json response", () => {
		expect(responseFrom('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}').result).toEqual({
			ok: true,
		})
	})

	it("reads a response delivered as a server-sent event", () => {
		const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'

		expect(responseFrom(body).result).toEqual({ ok: true })
	})

	it("takes the last frame when several arrive on one stream", () => {
		const body = [
			'data: {"jsonrpc":"2.0","id":1,"result":{"first":true}}',
			"",
			'data: {"jsonrpc":"2.0","id":2,"result":{"second":true}}',
			"",
		].join("\n")

		expect(responseFrom(body).result).toEqual({ second: true })
	})

	it("joins a frame split across several data lines", () => {
		expect(dataFramesOf('data: {"a":\ndata: 1}\n\n')).toEqual(['{"a":\n1}'])
	})

	it("raises the client's own error rather than returning it as a result", () => {
		const body = '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"no such tool"}}'

		expect(() => responseFrom(body)).toThrow(/no such tool/)
	})

	it("refuses an empty body rather than inventing a result", () => {
		expect(() => responseFrom("")).toThrow(McpProtocolError)
	})

	it("refuses a body that is not json", () => {
		expect(() => responseFrom("not json at all")).toThrow(McpProtocolError)
	})

	it("unwraps a tool result carried as json inside a text block", () => {
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: '{"connected":true}' }] },
			}),
		)

		expect(toolResultOf(response)).toEqual({ connected: true })
	})

	it("prefers a structured result when the client sends one", () => {
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { structuredContent: { connected: true }, content: [] },
			}),
		)

		expect(toolResultOf(response)).toEqual({ connected: true })
	})

	it("raises a tool that reports its own failure", () => {
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { isError: true, content: [{ type: "text", text: "capability_disabled" }] },
			}),
		)

		expect(() => toolResultOf(response)).toThrow(/capability_disabled/)
	})

	it("keeps plain text when a tool returns something that is not json", () => {
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: "hello" }] },
			}),
		)

		expect(toolResultOf(response)).toBe("hello")
	})

	it("names the tool and its arguments in the call it builds", () => {
		expect(callToolRequest(2, "mcc_session_status", {})).toEqual({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "mcc_session_status", arguments: {} },
		})
	})

	it("announces a protocol version in the handshake", () => {
		expect(initializeRequest(1, "open-mcc").params.protocolVersion).toBe("2025-06-18")
	})

	it("unwraps the envelope the client wraps every result in", () => {
		const real =
			'{"success":true,"data":{"host":"100.83.37.21","port":25566,"username":"LiveBot",' +
			'"protocolVersion":760,"terrainEnabled":false,"inventoryEnabled":false,' +
			'"entityEnabled":false,"location":{"x":-22.5,"y":81,"z":13.5}}}'
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: real }] },
			}),
		)

		expect(sessionStatusFrom(response)).toEqual({
			host: "100.83.37.21",
			port: 25566,
			username: "LiveBot",
			protocolVersion: 760,
			terrainEnabled: false,
			inventoryEnabled: false,
			entityEnabled: false,
			location: { x: -22.5, y: 81, z: 13.5 },
		})
	})

	it("raises the reason when the client reports the call unsuccessful", () => {
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [{ type: "text", text: '{"success":false,"error":"capability_disabled"}' }],
				},
			}),
		)

		expect(() => toolResultOf(response)).toThrow(/capability_disabled/)
	})

	it("names the reason the client gives when it refuses a disabled capability", () => {
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [{ type: "text", text: '{"success":false,"errorCode":"capability_disabled"}' }],
				},
			}),
		)

		expect(() => toolResultOf(response)).toThrow(/capability_disabled/)
	})

	it("reads the chat history a real client returned", () => {
		const real =
			'{"success":true,"data":{"count":1,"entries":[{"timestampUtc":' +
			'"2026-09-05T23:22:43.0381159+00:00","kind":"chat","text":"<LiveBot> hello",' +
			'"sender":"LiveBot","message":"hello","json":"hello"}]}}'
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: real }] },
			}),
		)

		expect(chatHistoryFrom(response)).toEqual([
			{
				timestampUtc: "2026-09-05T23:22:43.0381159+00:00",
				kind: "chat",
				text: "<LiveBot> hello",
				sender: "LiveBot",
				message: "hello",
				json: "hello",
			},
		])
	})

	it("keeps a whisper apart from public chat", () => {
		const body =
			'{"success":true,"data":{"count":1,"entries":[{"timestampUtc":"t","kind":"private",' +
			'"text":"x","sender":"Someone","message":"psst"}]}}'
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: body }] },
			}),
		)

		expect(chatHistoryFrom(response)[0]?.kind).toBe("private")
	})

	it("treats a kind it does not know as a system message rather than failing", () => {
		const body =
			'{"success":true,"data":{"count":1,"entries":[{"timestampUtc":"t","kind":"newthing",' +
			'"text":"x"}]}}'
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: body }] },
			}),
		)

		expect(chatHistoryFrom(response)[0]?.kind).toBe("system")
	})

	it("reports an absent sender as absent rather than as an empty name", () => {
		const body =
			'{"success":true,"data":{"count":1,"entries":[{"timestampUtc":"t","kind":"system",' +
			'"text":"x","sender":null,"message":"","json":null}]}}'
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: body }] },
			}),
		)
		const entry = chatHistoryFrom(response)[0]

		expect(entry?.sender).toBeUndefined()
		expect(entry?.message).toBeUndefined()
		expect(entry?.json).toBeUndefined()
	})

	it("reads an empty history without complaint", () => {
		const body = '{"success":true,"data":{"count":0,"entries":[]}}'
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: body }] },
			}),
		)

		expect(chatHistoryFrom(response)).toEqual([])
	})

	it("reads the events a real client returned", () => {
		const real =
			'{"success":true,"data":{"afterId":0,"latestId":205,"count":2,"events":[' +
			'{"id":1,"timestampUtc":"2026-09-05T22:46:29Z","type":"player_join",' +
			'"data":{"uuid":"u","name":"LiveBot"}},' +
			'{"id":2,"timestampUtc":"2026-09-05T22:46:30Z","type":"death"}]}}'
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: real }] },
			}),
		)
		const page = recentEventsFrom(response)

		expect(page.latestId).toBe(205)
		expect(page.events).toEqual([
			{ id: 1, timestampUtc: "2026-09-05T22:46:29Z", type: "player_join", subject: "LiveBot" },
			{ id: 2, timestampUtc: "2026-09-05T22:46:30Z", type: "death", subject: undefined },
		])
	})

	it("drops the animation traffic that would drown the useful events", () => {
		const body =
			'{"success":true,"data":{"afterId":0,"latestId":9,"count":3,"events":[' +
			'{"id":1,"timestampUtc":"t","type":"entity_animation"},' +
			'{"id":2,"timestampUtc":"t","type":"block_break_animation"},' +
			'{"id":3,"timestampUtc":"t","type":"death"}]}}'
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: body }] },
			}),
		)

		expect(recentEventsFrom(response).events.map((event) => event.type)).toEqual(["death"])
	})

	it("keeps an event type it has never seen, so nothing new is lost", () => {
		expect(isNotableEvent("some_future_event")).toBe(true)
	})

	it("carries the cursor forward so the next read starts where this one ended", () => {
		const body = '{"success":true,"data":{"afterId":10,"latestId":42,"count":0,"events":[]}}'
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: body }] },
			}),
		)

		expect(recentEventsFrom(response)).toEqual({ latestId: 42, events: [] })
	})

	it("reads the entities a real client returned", () => {
		const real =
			'{"success":true,"data":{"totalTracked":161,"count":1,"entities":[' +
			'{"id":18452,"type":"Skeleton","typeLabel":"Skeleton",' +
			'"uuid":"c7dcbe63-11cb-4d50-b12d-bea8f452f644","distance":12.5}]}}'
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: real }] },
			}),
		)

		expect(entityListFrom(response)).toEqual({
			totalTracked: 161,
			entities: [{ id: 18452, label: "Skeleton", distance: 12.5, health: undefined }],
		})
	})

	it("prefers a named entity's name over its type", () => {
		const body =
			'{"success":true,"data":{"totalTracked":1,"entities":[' +
			'{"id":1,"type":"Villager","typeLabel":"Villager","name":"Bob"}]}}'
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: body }] },
			}),
		)

		expect(entityListFrom(response).entities[0]?.label).toBe("Bob")
	})

	it("names an entity it cannot identify rather than showing a blank row", () => {
		const body = '{"success":true,"data":{"totalTracked":1,"entities":[{"id":7}]}}'
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: body }] },
			}),
		)

		expect(entityListFrom(response).entities[0]?.label).toBe("unknown")
	})

	it("reads an empty radius without complaint", () => {
		const body = '{"success":true,"data":{"totalTracked":0,"count":0,"entities":[]}}'
		const response = responseFrom(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: body }] },
			}),
		)

		expect(entityListFrom(response)).toEqual({ totalTracked: 0, entities: [] })
	})
})

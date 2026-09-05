import { describe, expect, it } from "vitest"
import {
	callToolRequest,
	dataFramesOf,
	initializeRequest,
	McpProtocolError,
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
})

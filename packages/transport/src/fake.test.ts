import { describe, expect, it } from "vitest"
import { ReadConnectionLostError } from "./errors"
import { createFakeTransport } from "./fake"
import { LiveChannelUnavailableError } from "./types"

const connectOptions = {
	hostname: "host",
	port: 22,
	username: "user",
	privateKey: "key",
	expectedFingerprint: "SHA256:whatever",
	timeoutMs: 1000,
}

describe("createFakeTransport", () => {
	it("moves state to ready on connect", async () => {
		const transport = createFakeTransport()
		expect(transport.state()).toBe("disconnected")
		await transport.connect(connectOptions)
		expect(transport.state()).toBe("ready")
	})

	it("records commands in order", async () => {
		const transport = createFakeTransport()
		await transport.connect(connectOptions)
		await transport.exec("one", 1000)
		await transport.exec("two", 1000)
		expect(transport.commands).toEqual(["one", "two"])
	})

	it("returns a zero exit with empty output for an unscripted command", async () => {
		const transport = createFakeTransport()
		await transport.connect(connectOptions)
		const result = await transport.exec("whatever", 1000)
		expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 })
	})

	it("returns the scripted result for a matching command", async () => {
		const transport = createFakeTransport({
			"echo hi": { stdout: "hi\n", stderr: "", exitCode: 0 },
		})
		await transport.connect(connectOptions)
		const result = await transport.exec("echo hi", 1000)
		expect(result).toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 })
	})

	it("returns state to disconnected on close", async () => {
		const transport = createFakeTransport()
		await transport.connect(connectOptions)
		expect(transport.state()).toBe("ready")
		await transport.close()
		expect(transport.state()).toBe("disconnected")
	})

	it("rejects connect with an injected failure and does not become ready", async () => {
		const transport = createFakeTransport({}, { connect: new Error("connection refused") })
		await expect(transport.connect(connectOptions)).rejects.toThrow("connection refused")
		expect(transport.state()).not.toBe("ready")
	})

	it("rejects exec before any connect with the real transport's message", async () => {
		const transport = createFakeTransport()
		await expect(transport.exec("docker --version", 1000)).rejects.toThrow(
			"Transport is not connected",
		)
	})

	it("rejects exec after close with the real transport's message", async () => {
		const transport = createFakeTransport()
		await transport.connect(connectOptions)
		await transport.close()
		await expect(transport.exec("docker --version", 1000)).rejects.toThrow(
			"Transport is not connected",
		)
	})

	it("rejects an injected exec failure for a named command while other commands still succeed", async () => {
		const transport = createFakeTransport(
			{ "echo hi": { stdout: "hi\n", stderr: "", exitCode: 0 } },
			{ exec: { "docker --version": new Error("connection reset") } },
		)
		await transport.connect(connectOptions)
		await expect(transport.exec("docker --version", 1000)).rejects.toThrow("connection reset")
		const result = await transport.exec("echo hi", 1000)
		expect(result).toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 })
	})

	it("holds a stalled command open until the caller abandons it, with the caller's reason", async () => {
		const transport = createFakeTransport({}, { stall: ["sleep"] })
		await transport.connect(connectOptions)
		const giveUp = new AbortController()
		const reason = new Error("deadline")

		const running = transport.execUntil("sleep", giveUp.signal)
		giveUp.abort(reason)

		await expect(running).rejects.toBe(reason)
		expect(transport.commands).toEqual(["sleep"])
	})

	it("fails whatever is stalled, and closes open forwards, when the connection drops", async () => {
		const transport = createFakeTransport({}, { stall: ["sleep"], stallPorts: [9] })
		await transport.connect(connectOptions)
		const never = new AbortController().signal
		const command = transport.execUntil("sleep", never)
		const opening = transport.forwardUntil(9, never)
		const open = await transport.forwardUntil(33333, never)
		const closed = new Promise((resolve) => open.socket.once("close", resolve))

		transport.drop()

		await expect(command).rejects.toBeInstanceOf(ReadConnectionLostError)
		await expect(opening).rejects.toBeInstanceOf(ReadConnectionLostError)
		await closed
		expect(transport.state()).toBe("disconnected")
		expect(transport.destroyCount()).toBe(0)
	})

	it("counts a destroy apart from a graceful close", async () => {
		const transport = createFakeTransport()
		await transport.connect(connectOptions)
		transport.destroy()
		await transport.close()

		expect(transport.destroyCount()).toBe(1)
		expect(transport.closeCount()).toBe(1)
		await expect(transport.execUntil("ls", new AbortController().signal)).rejects.toBeInstanceOf(
			ReadConnectionLostError,
		)
	})

	it("refuses a forward the way a host with forwarding off does", async () => {
		const transport = createFakeTransport({}, {}, false)
		await transport.connect(connectOptions)

		await expect(
			transport.forwardUntil(33333, new AbortController().signal),
		).rejects.toBeInstanceOf(LiveChannelUnavailableError)
	})
})

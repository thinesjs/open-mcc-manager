import { describe, expect, it } from "vitest"
import { createFakeTransport } from "./fake"

describe("createFakeTransport", () => {
	it("moves state to ready on connect", async () => {
		const transport = createFakeTransport()
		expect(transport.state()).toBe("disconnected")
		await transport.connect({
			hostname: "host",
			port: 22,
			username: "user",
			privateKey: "key",
			expectedFingerprint: "SHA256:whatever",
			timeoutMs: 1000,
		})
		expect(transport.state()).toBe("ready")
	})

	it("records commands in order", async () => {
		const transport = createFakeTransport()
		await transport.exec("one", 1000)
		await transport.exec("two", 1000)
		expect(transport.commands).toEqual(["one", "two"])
	})

	it("returns a zero exit with empty output for an unscripted command", async () => {
		const transport = createFakeTransport()
		const result = await transport.exec("whatever", 1000)
		expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 })
	})

	it("returns the scripted result for a matching command", async () => {
		const transport = createFakeTransport({
			"echo hi": { stdout: "hi\n", stderr: "", exitCode: 0 },
		})
		const result = await transport.exec("echo hi", 1000)
		expect(result).toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 })
	})

	it("returns state to disconnected on close", async () => {
		const transport = createFakeTransport()
		await transport.connect({
			hostname: "host",
			port: 22,
			username: "user",
			privateKey: "key",
			expectedFingerprint: "SHA256:whatever",
			timeoutMs: 1000,
		})
		expect(transport.state()).toBe("ready")
		await transport.close()
		expect(transport.state()).toBe("disconnected")
	})
})

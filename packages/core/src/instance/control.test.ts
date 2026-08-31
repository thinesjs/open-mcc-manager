import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { readConsole, sendCommand } from "./control"

const connected = async () => {
	const transport = createFakeTransport()
	await transport.connect({
		hostname: "h",
		port: 22,
		username: "root",
		privateKey: "k",
		expectedFingerprint: "f",
		timeoutMs: 1000,
	})
	return transport
}

describe("instance control channel", () => {
	it("refuses a command containing a newline without dialling out at all", async () => {
		const transport = await connected()
		await expect(sendCommand(transport, "abc", "/say hi\n/op attacker")).rejects.toThrow(/newline/i)
		expect(transport.commands).toEqual([])
	})

	it("refuses an id that is not a validated instance id without dialling out", async () => {
		const transport = await connected()
		await expect(sendCommand(transport, "../../etc", "/say hi")).rejects.toThrow()
		expect(transport.commands).toEqual([])
	})

	it("writes exactly one newline-terminated line to that instance's fifo", async () => {
		const transport = await connected()
		await sendCommand(transport, "abc", "/say hi")
		expect(transport.commands[0]).toBe("cat > '/srv/open-mcc/instances/abc/control'")
		expect(transport.stdins[0]).toBe("/say hi\n")
	})

	it("bounds the journal read rather than streaming the whole unit history", async () => {
		const transport = await connected()
		await readConsole(transport, "abc", 100)
		expect(transport.commands[0]).toContain("--lines 100")
		expect(transport.commands[0]).toContain("open-mcc@abc")
	})

	it("refuses an unbounded or absurd line count", async () => {
		const transport = await connected()
		await expect(readConsole(transport, "abc", 0)).rejects.toThrow()
		await expect(readConsole(transport, "abc", 10_000)).rejects.toThrow()
		expect(transport.commands).toEqual([])
	})
})

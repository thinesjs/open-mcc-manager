import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { rootlessProfile, systemProfile } from "../host/profile"
import {
	controlLine,
	DisallowedInternalCommandError,
	INTERNAL_COMMANDS,
	readConsole,
	sendCommand,
} from "./control"

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
		await expect(
			sendCommand(transport, "abc", "/say hi\n/op attacker", "/srv/open-mcc"),
		).rejects.toThrow(/newline/i)
		expect(transport.commands).toEqual([])
	})

	it("refuses an id that is not a validated instance id without dialling out", async () => {
		const transport = await connected()
		await expect(sendCommand(transport, "../../etc", "/say hi", "/srv/open-mcc")).rejects.toThrow()
		expect(transport.commands).toEqual([])
	})

	it("writes exactly one newline-terminated line to that instance's fifo", async () => {
		const transport = await connected()
		await sendCommand(transport, "abc", "hi", "/srv/open-mcc")
		expect(transport.commands[0]).toBe("cat > '/srv/open-mcc/instances/abc/control'")
		expect(transport.stdins[0]).toBe("hi\n")
	})

	it("keeps a slash-prefixed line out of the client's own command handler", async () => {
		const transport = await connected()
		await sendCommand(transport, "abc", "/say hi", "/srv/open-mcc")
		expect(transport.stdins[0]).toBe("//say hi\n")
	})

	it("denies console.write a path to running code on the host", () => {
		for (const escalation of [
			"!script pwn",
			"!upgrade",
			"!connect evil.example.net",
			"!tryout tui",
		]) {
			expect(() => controlLine(escalation)).toThrow(DisallowedInternalCommandError)
		}
	})

	it("refuses a denied client command whatever its casing or spacing", () => {
		for (const spelling of ["!SCRIPT pwn", "!  Script pwn", "!sCrIpT"]) {
			expect(() => controlLine(spelling)).toThrow(DisallowedInternalCommandError)
		}
	})

	it("keeps every escalating command out of the allowed set", () => {
		for (const denied of ["script", "upgrade", "connect", "tryout", "set", "reload", "bots"]) {
			expect(INTERNAL_COMMANDS.some((allowed) => allowed === denied)).toBe(false)
		}
	})

	it("sends chat text through untouched", () => {
		expect(controlLine("hello world")).toBe("hello world")
	})

	it("routes a slash line to the server rather than the client's own handler", () => {
		expect(controlLine("/home")).toBe("//home")
	})

	it("preserves a doubled slash so plugin commands still reach the server", () => {
		expect(controlLine("//set stone")).toBe("///set stone")
	})

	it("runs an allowed client command, which a slash line could never reach", () => {
		expect(controlLine("!respawn")).toBe("/respawn")
		expect(controlLine("!list")).toBe("/list")
	})

	it("bounds the journal read rather than streaming the whole unit history", async () => {
		const transport = await connected()
		await readConsole(transport, "abc", 100, systemProfile())
		expect(transport.commands[0]).toContain("--lines 100")
		expect(transport.commands[0]).toContain("open-mcc@abc")
	})

	it("reads the user journal on a rootless host, where the unit's log only exists", async () => {
		const transport = await connected()
		await readConsole(transport, "abc", 100, rootlessProfile("/home/pi"))
		expect(transport.commands[0]).toContain("journalctl --user")
	})

	it("reads the system journal on a host running system units", async () => {
		const transport = await connected()
		await readConsole(transport, "abc", 100, systemProfile())
		expect(transport.commands[0]).not.toContain("--user")
	})

	it("refuses an unbounded or absurd line count", async () => {
		const transport = await connected()
		await expect(readConsole(transport, "abc", 0, systemProfile())).rejects.toThrow()
		await expect(readConsole(transport, "abc", 10_000, systemProfile())).rejects.toThrow()
		expect(transport.commands).toEqual([])
	})
})

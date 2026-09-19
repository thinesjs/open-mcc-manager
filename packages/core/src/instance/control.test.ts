import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import {
	controlLine,
	DisallowedInternalCommandError,
	DoubleSlashCredentialError,
	INTERNAL_COMMANDS,
	refuseStoredCredential,
	StoredCredentialError,
	sendableLine,
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
		await expect(sendCommand(transport, "abc", "/say hi\n/op attacker")).rejects.toThrow(
			/control character/i,
		)
		expect(transport.commands).toEqual([])
	})

	it("refuses an id that is not a validated instance id without dialling out", async () => {
		const transport = await connected()
		await expect(sendCommand(transport, "../../etc", "/say hi")).rejects.toThrow()
		expect(transport.commands).toEqual([])
	})

	it("writes exactly one newline-terminated line to that instance's fifo", async () => {
		const transport = await connected()
		await sendCommand(transport, "abc", "hi")
		expect(transport.commands[0]).toBe('cat > "$HOME"/.local/share/open-mcc/instances/abc/control')
		expect(transport.stdins[0]).toBe("hi\n")
	})

	it("keeps a slash-prefixed line out of the client's own command handler", async () => {
		const transport = await connected()
		await sendCommand(transport, "abc", "/say hi")
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

	it("refuses a password behind two slashes, which the server would never act on", async () => {
		const transport = await connected()

		await expect(sendCommand(transport, "abc", "//login hunter2")).rejects.toThrow(
			DoubleSlashCredentialError,
		)
		expect(transport.stdins).toEqual([])
	})

	it("still sends the plugin commands that need two slashes", async () => {
		const transport = await connected()

		for (const command of ["//wand", "//set stone", "//copy", "//paste"]) {
			await sendCommand(transport, "abc", command)
		}

		expect(transport.stdins).toEqual(["///wand\n", "///set stone\n", "///copy\n", "///paste\n"])
	})

	it("sends a password behind one slash, which is the form that works", async () => {
		const transport = await connected()

		await sendCommand(transport, "abc", "/login hunter2")

		expect(transport.stdins).toEqual(["//login hunter2\n"])
	})

	it("★ refuses to store every credential form the redactor masks, and stores the rest", () => {
		for (const refused of [
			"/login hunter2",
			"login hunter2",
			"//login hunter2",
			"/l hunter2",
			"/register hunter2 hunter2",
			"/unregister hunter2",
			"/changepassword old new",
			"/authme changepassword old new",
			"/email setpassword old new",
			"  /LOGIN hunter2",
		]) {
			expect(() => refuseStoredCredential(refused), refused).toThrow(StoredCredentialError)
		}

		for (const stored of [
			"/say hello",
			"!reco",
			"/login",
			"say login hunter2",
			"/home",
			"/logistics open",
		]) {
			expect(() => refuseStoredCredential(stored), stored).not.toThrow()
		}
	})

	it("★ refuses more than passwords: any argument to these verbs counts as one", () => {
		for (const refused of ["/cp backup world", "/log the weather", "/l lobby", "/reg tuesday"]) {
			expect(() => refuseStoredCredential(refused), refused).toThrow(StoredCredentialError)
		}
	})

	it("★ leaves the send door taking the password the store door refuses", () => {
		expect(sendableLine("/login hunter2")).toBe("//login hunter2")
		expect(() => refuseStoredCredential("/login hunter2")).toThrow(StoredCredentialError)
	})

	it("preserves a doubled slash so plugin commands still reach the server", () => {
		expect(controlLine("//set stone")).toBe("///set stone")
	})

	it("runs an allowed client command, which a slash line could never reach", () => {
		expect(controlLine("!respawn")).toBe("/respawn")
		expect(controlLine("!list")).toBe("/list")
	})

	it("emits an allowed command in the exact casing MCC's parser matches", () => {
		expect(controlLine("!List")).toBe("/list")
		expect(controlLine("!RESPAWN")).toBe("/respawn")
	})

	it("separates arguments with the single space MCC's parser requires", () => {
		expect(controlLine("!list\textra")).toBe("/list extra")
		expect(controlLine("!look  north   east")).toBe("/look north east")
	})

	it("refuses a command that would read a file off the host", () => {
		expect(() => controlLine("!book write file /etc/passwd")).toThrow(
			DisallowedInternalCommandError,
		)
	})

	it("refuses a command that can forge the markers reconciliation reads", () => {
		expect(() => controlLine("!log Not connected to any server")).toThrow(
			DisallowedInternalCommandError,
		)
	})

	it("refuses a control character, which the client reads as a protocol frame", async () => {
		const transport = await connected()
		await expect(sendCommand(transport, "abc", "\u0000autocomplete")).rejects.toThrow()
		expect(transport.commands).toEqual([])
	})

	it("writes nothing to the fifo when the command is denied", async () => {
		const transport = await connected()
		await expect(sendCommand(transport, "abc", "!script pwn")).rejects.toThrow(
			DisallowedInternalCommandError,
		)
		expect(transport.commands).toEqual([])
		expect(transport.stdins).toEqual([])
	})

	it("refuses to reconnect an instance as a different account", () => {
		expect(() => controlLine("!reco AccountNikename2")).toThrow(DisallowedInternalCommandError)
	})

	it("still reconnects an instance as itself", () => {
		expect(controlLine("!reco")).toBe("/reco")
	})

	it("refuses a command whose only use is state no operator can read", () => {
		expect(() => controlLine("!setrnd x 1 9")).toThrow(DisallowedInternalCommandError)
	})
})

describe("following a player from the manager", () => {
	it("runs the follow command in the form the client actually accepts", () => {
		expect(controlLine("!follow start Steve")).toBe("/follow start Steve")
	})

	it("carries the client's own risk flag through untouched", () => {
		expect(controlLine("!follow start Steve -f")).toBe("/follow start Steve -f")
	})

	it("lets the operator stop following", () => {
		expect(controlLine("!follow stop")).toBe("/follow stop")
	})

	it("still refuses the commands that reach the client's own escalating surface", () => {
		for (const denied of ["!script pwn", "!set a b", "!reload"]) {
			expect(() => controlLine(denied)).toThrow(DisallowedInternalCommandError)
		}
	})
})

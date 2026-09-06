import { describe, expect, it } from "vitest"
import {
	ALLOWED_CONFIG_KEYS,
	allocateLiveControlPort,
	EMPTIED_CONFIG_SECTIONS,
	FIXED_CONFIG_KEYS,
	LiveControlPortsExhaustedError,
	renderInstanceConfig,
	splitServerAddress,
} from "./config"

const base = {
	accountType: "microsoft",
	minecraftAccount: "afk@example.com",
	serverAddress: "play.example.com:25566",
	autoRelogRetries: 3,
	autoRelogDelaySeconds: 10,
	antiAfkEnabled: true,
	antiAfkIntervalSeconds: 60,
	autoRespawnEnabled: false,
	liveControlEnabled: false,
	liveControlPort: 33333,
	worldDataEnabled: false,
	inventoryDataEnabled: false,
	entityDataEnabled: false,
} as const

describe("instance config rendering", () => {
	it("keeps a crafted value on one line so it cannot become structure", () => {
		const hostile = 'play.example.com"\n[ChatBot.Script]\nScript_File = "evil'
		const rendered = renderInstanceConfig({ ...base, serverAddress: hostile })

		const sections = rendered.split("\n").filter((line) => line.startsWith("["))
		expect(sections).toEqual([
			"[Main.General]",
			"[Main.General.Account]",
			"[Main.General.Server]",
			"[Main.Advanced]",
			"[Main.Advanced.AccountList]",
			"[Main.Advanced.ServerList]",
			"[ChatBot.AutoRelog]",
			"[ChatBot.AntiAFK]",
			"[ChatBot.McpServer]",
			"[ChatBot.McpServer.Transport]",
			"[ChatBot.McpServer.Capabilities]",
		])

		const hostLines = rendered.split("\n").filter((line) => line.startsWith("Host = "))
		expect(hostLines).toHaveLength(1)
		expect(hostLines[0]).not.toContain("\n")

		const assignments = rendered
			.split("\n")
			.filter((line) => /^[A-Za-z_][A-Za-z0-9_]* = /.test(line))
			.map((line) => line.split(" = ")[0])
		expect(assignments).toEqual([
			"AccountType",
			"Method",
			"Login",
			"Password",
			"Host",
			"EnableSentry",
			"ExitOnFailure",
			"InternalCmdChar",
			"AutoRespawn",
			"TerrainAndMovements",
			"InventoryHandling",
			"EntityHandling",
			"Enabled",
			"Retries",
			"Delay",
			"Enabled",
			"Delay",
			"Enabled",
			"BindHost",
			"Port",
			"Route",
			"RequireAuthToken",
			"AuthTokenEnvVar",
			"SessionStatus",
			"ChatAndCommands",
			"Movement",
			"Inventory",
			"EntityWorld",
		])
	})

	it("emits no script-referencing key for any input", () => {
		const rendered = renderInstanceConfig(base)
		for (const forbidden of ["Script", "Task_File", ".cs", "CSharpRunner", "ScriptScheduler"]) {
			expect(rendered).not.toContain(forbidden)
		}
	})

	it("escapes a value containing a quote rather than terminating the string", () => {
		const rendered = renderInstanceConfig({ ...base, serverAddress: 'a"b' })
		expect(rendered).toContain('Host = "a\\"b"')
	})

	it("emits exactly the keys ALLOWED_CONFIG_KEYS names, so the list cannot drift from the output", () => {
		const rendered = renderInstanceConfig(base)
		let section = ""
		const emitted: string[] = []
		for (const line of rendered.split("\n")) {
			if (line.startsWith("[")) {
				section = line.slice(1, -1)
				continue
			}
			const match = /^([A-Za-z_][A-Za-z0-9_]*) = /.exec(line)
			if (match) emitted.push(`${section}.${match[1]}`)
		}
		expect(emitted.sort()).toEqual([...ALLOWED_CONFIG_KEYS, ...FIXED_CONFIG_KEYS].sort())
	})

	it("opts out of the client's error telemetry, whatever the operator asks for", () => {
		const rendered = renderInstanceConfig(base)
		expect(rendered).toContain("[Main.Advanced]")
		expect(rendered.match(/^EnableSentry = .*$/gm)).toEqual(["EnableSentry = false"])
	})

	it("makes the client exit on failure, without which systemd never sees a crash", () => {
		const rendered = renderInstanceConfig(base)
		expect(rendered.match(/^ExitOnFailure = .*$/gm)).toEqual(["ExitOnFailure = true"])
	})

	it("escapes every control character, which toml forbids raw in a basic string", () => {
		const hostile = `play\u0000example\u0001com\u001f\u007f`
		const rendered = renderInstanceConfig({ ...base, serverAddress: hostile })

		expect(rendered).toContain("\\u0000")
		expect(rendered).toContain("\\u0001")
		expect(rendered).toContain("\\u001f")
		expect(rendered).toContain("\\u007f")
		const raw = [...rendered].filter((character) => {
			const code = character.charCodeAt(0)
			return (code < 0x20 && character !== "\n") || code === 0x7f
		})
		expect(raw).toEqual([])
	})

	it("still escapes the characters that would end the string or add a line", () => {
		const rendered = renderInstanceConfig({
			...base,
			serverAddress: 'a"b\\c\nd\te',
		})
		const hostLines = rendered.split("\n").filter((line) => line.startsWith("Host = "))
		expect(hostLines).toHaveLength(1)
	})

	it("never lets operator input reach a key the manager fixes", () => {
		const rendered = renderInstanceConfig({
			...base,
			minecraftAccount: 'x"\nEnableSentry = true\n',
			serverAddress: "EnableSentry = true",
		})
		expect(rendered.match(/^EnableSentry = .*$/gm)).toEqual(["EnableSentry = false"])
	})

	it("marks an offline account with the sentinel password MCC short-circuits login on", () => {
		const rendered = renderInstanceConfig({
			...base,
			accountType: "offline",
			minecraftAccount: "Steve",
		})

		expect(rendered).toContain('Password = "-"')
		expect(rendered).toContain('Login = "Steve"')
	})

	it("leaves the password empty for every account type that authenticates", () => {
		expect(renderInstanceConfig({ ...base, accountType: "microsoft" })).toContain('Password = ""')
	})

	it("maps an offline account onto a login type MCC's enum accepts", () => {
		const rendered = renderInstanceConfig({ ...base, accountType: "offline" })

		expect(rendered).toContain('AccountType = "microsoft"')
	})

	it("names an authenticating account type as MCC spells it", () => {
		expect(renderInstanceConfig({ ...base, accountType: "microsoft" })).toContain(
			'AccountType = "microsoft"',
		)
	})

	it("declares the general scalar before the account sub-table so TOML nests neither inside the other", () => {
		const lines = renderInstanceConfig(base).split("\n")

		expect(lines.indexOf("[Main.General]")).toBeLessThan(lines.indexOf("[Main.General.Account]"))
		expect(lines.findIndex((line) => line.startsWith("AccountType = "))).toBeLessThan(
			lines.indexOf("[Main.General.Account]"),
		)
	})

	it("pins the character that decides whether a line we send is a command or chat", () => {
		expect(renderInstanceConfig(base)).toContain('InternalCmdChar = "slash"')
	})

	it("declares that character fixed, because the send path's meaning depends on it", () => {
		expect(FIXED_CONFIG_KEYS).toContain("Main.Advanced.InternalCmdChar")
	})

	it("leaves a client dead by default, because respawning into a lethal spawn loops", () => {
		expect(renderInstanceConfig(base)).toContain("AutoRespawn = false")
	})

	it("respawns the client when the operator asks for it", () => {
		expect(renderInstanceConfig({ ...base, autoRespawnEnabled: true })).toContain(
			"AutoRespawn = true",
		)
	})

	it("pins sign-in to the device code, the only flow a headless host can complete", () => {
		expect(renderInstanceConfig(base)).toContain('Method = "mcc"')
	})

	it("declares the sign-in method fixed, since a browser flow has no display to open", () => {
		expect(FIXED_CONFIG_KEYS).toContain("Main.General.Method")
	})

	it("empties the alias lists MCC ships examples in, so no second identity exists", () => {
		const rendered = renderInstanceConfig(base)

		for (const section of EMPTIED_CONFIG_SECTIONS) {
			expect(rendered).toContain(`[${section}]`)
		}
		expect(rendered).not.toContain("AccountNikename")
	})

	it("declares every emptied section, so the list cannot drift from the output", () => {
		const rendered = renderInstanceConfig(base)
		const emptied = rendered
			.split("\n")
			.filter((line, index, lines) => line.startsWith("[") && lines[index + 1] === "")
			.map((line) => line.slice(1, -1))

		for (const section of EMPTIED_CONFIG_SECTIONS) {
			expect(emptied).toContain(section)
		}
	})

	it("splits a port off the address, because the client stores them separately", () => {
		const rendered = renderInstanceConfig({ ...base, serverAddress: "play.example.net:25566" })

		expect(rendered).toContain('Host = "play.example.net"')
		expect(rendered).toContain("Port = 25566")
	})

	it("writes no port when the address carries none, letting the client resolve it", () => {
		const rendered = renderInstanceConfig({ ...base, serverAddress: "play.example.net" })
		const serverSection = rendered.split("[Main.General.Server]")[1]?.split("[")[0]

		expect(rendered).toContain('Host = "play.example.net"')
		expect(serverSection).not.toContain("Port = ")
	})

	it("leaves an address alone when what follows the colon is not a port", () => {
		expect(splitServerAddress("play.example.net:notaport")).toEqual({
			host: "play.example.net:notaport",
			port: undefined,
		})
		expect(splitServerAddress("play.example.net:99999")).toEqual({
			host: "play.example.net:99999",
			port: undefined,
		})
	})

	it("does not try to split a bracketed address", () => {
		expect(splitServerAddress("[::1]:25565")).toEqual({ host: "[::1]:25565", port: undefined })
	})

	it("switches the live endpoint off unless the operator asked for it", () => {
		const rendered = renderInstanceConfig(base)

		expect(rendered).toContain("[ChatBot.McpServer]")
		expect(rendered.match(/^Enabled = .*$/gm)?.at(-1)).toBe("Enabled = false")
	})

	it("requires a token on the live endpoint, which the client does not by default", () => {
		expect(renderInstanceConfig(base)).toContain("RequireAuthToken = true")
	})

	it("pins the live endpoint to loopback, never offering the choice", () => {
		const rendered = renderInstanceConfig({ ...base, liveControlEnabled: true })

		expect(rendered).toContain('BindHost = "127.0.0.1"')
		expect(rendered).not.toContain("0.0.0.0")
	})

	it("denies the live endpoint every write, leaving the fifo the only way in", () => {
		const rendered = renderInstanceConfig({ ...base, liveControlEnabled: true })

		expect(rendered).toContain("ChatAndCommands = false")
		expect(rendered).toContain("Movement = false")
		expect(rendered).toContain("Inventory = false")
		expect(rendered).toContain("EntityWorld = false")
	})

	it("opens the read surface only when live control is on", () => {
		expect(renderInstanceConfig({ ...base, liveControlEnabled: true })).toContain(
			"SessionStatus = true",
		)
		expect(renderInstanceConfig(base)).toContain("SessionStatus = false")
	})

	it("gives each instance its own port, since rootless siblings share a network", () => {
		expect(renderInstanceConfig({ ...base, liveControlPort: 33401 })).toContain("Port = 33401")
	})

	it("gives the first instance on a host the client's own default port", () => {
		expect(allocateLiveControlPort([])).toBe(33333)
	})

	it("never hands two instances the same port, since they share a network namespace", () => {
		expect(allocateLiveControlPort([33333])).toBe(33334)
		expect(allocateLiveControlPort([33333, 33334, 33335])).toBe(33336)
	})

	it("reuses a port freed by a removed instance", () => {
		expect(allocateLiveControlPort([33333, 33335])).toBe(33334)
	})

	it("refuses to hand out a port outside the range it owns", () => {
		const everyPort = Array.from({ length: 500 }, (_, index) => 33333 + index)

		expect(() => allocateLiveControlPort(everyPort)).toThrow(LiveControlPortsExhaustedError)
	})

	it("leaves the costly handlers off, since they are what makes the client heavy", () => {
		const rendered = renderInstanceConfig(base)

		expect(rendered).toContain("TerrainAndMovements = false")
		expect(rendered).toContain("InventoryHandling = false")
		expect(rendered).toContain("EntityHandling = false")
	})

	it("turns on terrain handling without granting the live channel any write", () => {
		const rendered = renderInstanceConfig({
			...base,
			liveControlEnabled: true,
			worldDataEnabled: true,
		})

		expect(rendered).toContain("TerrainAndMovements = true")
		expect(rendered).toContain("Inventory = false")
		expect(rendered).toContain("EntityWorld = false")
	})

	it("opens the inventory capability only alongside the handler that fills it", () => {
		const rendered = renderInstanceConfig({
			...base,
			liveControlEnabled: true,
			inventoryDataEnabled: true,
		})

		expect(rendered).toContain("InventoryHandling = true")
		expect(rendered).toContain("Inventory = true")
	})

	it("opens the entity capability only alongside the handler that fills it", () => {
		const rendered = renderInstanceConfig({
			...base,
			liveControlEnabled: true,
			entityDataEnabled: true,
		})

		expect(rendered).toContain("EntityHandling = true")
		expect(rendered).toContain("EntityWorld = true")
	})

	it("keeps a capability shut while live control is off, whatever the data toggles say", () => {
		const rendered = renderInstanceConfig({
			...base,
			liveControlEnabled: false,
			inventoryDataEnabled: true,
			entityDataEnabled: true,
		})

		expect(rendered).toContain("Inventory = false")
		expect(rendered).toContain("EntityWorld = false")
	})
})

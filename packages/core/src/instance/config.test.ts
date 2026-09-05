import { describe, expect, it } from "vitest"
import { ALLOWED_CONFIG_KEYS, FIXED_CONFIG_KEYS, renderInstanceConfig } from "./config"

const base = {
	accountType: "microsoft",
	minecraftAccount: "afk@example.com",
	serverAddress: "play.example.com",
	autoRelogRetries: 3,
	autoRelogDelaySeconds: 10,
	antiAfkEnabled: true,
	antiAfkIntervalSeconds: 60,
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
			"[ChatBot.AutoRelog]",
			"[ChatBot.AntiAFK]",
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
			"Login",
			"Password",
			"Host",
			"EnableSentry",
			"ExitOnFailure",
			"InternalCmdChar",
			"Enabled",
			"Retries",
			"Delay",
			"Enabled",
			"Delay",
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
})

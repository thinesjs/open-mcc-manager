import { describe, expect, it } from "vitest"
import { ALLOWED_CONFIG_KEYS, FIXED_CONFIG_KEYS, renderInstanceConfig } from "./config"

const base = {
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
			"Login",
			"Host",
			"EnableSentry",
			"ExitOnFailure",
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

	it("never lets operator input reach a key the manager fixes", () => {
		const rendered = renderInstanceConfig({
			...base,
			minecraftAccount: 'x"\nEnableSentry = true\n',
			serverAddress: "EnableSentry = true",
		})
		expect(rendered.match(/^EnableSentry = .*$/gm)).toEqual(["EnableSentry = false"])
	})
})

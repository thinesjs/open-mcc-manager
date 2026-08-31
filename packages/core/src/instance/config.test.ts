import { describe, expect, it } from "vitest"
import { renderInstanceConfig } from "./config"

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
})

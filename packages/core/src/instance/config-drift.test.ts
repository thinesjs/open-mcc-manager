import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { renderInstanceConfig } from "./config"
import { compareInstanceConfig, describeConfigDrift, isSafetyDrift } from "./config-drift"

const base = {
	accountType: "offline",
	minecraftAccount: "OpenMccBot",
	serverAddress: "100.83.37.21",
	autoRelogRetries: 3,
	autoRelogDelaySeconds: 10,
	antiAfkEnabled: false,
	antiAfkIntervalSeconds: 60,
	autoRespawnEnabled: false,
	liveControlEnabled: false,
	liveControlPort: 33333,
} as const

const realConfig = readFileSync(
	join(__dirname, "../../../contracts/src/boundary/mcc-config-fixture.ini"),
	"utf8",
)

describe("instance config drift", () => {
	it("reports nothing when the host holds what we rendered", () => {
		const document = renderInstanceConfig(base)

		expect(compareInstanceConfig(document, document)).toEqual([])
	})

	it("agrees with the document the client expanded, on every key it was told about", () => {
		const expected = renderInstanceConfig({ ...base, accountType: "offline" })
		const settled = compareInstanceConfig(expected, realConfig).filter(
			(entry) => entry.kind !== "section" && !entry.key.startsWith("ChatBot.McpServer."),
		)

		expect(settled).toEqual([])
	})

	it("reports the client's own defaults for live control as drift, because they are unsafe", () => {
		const expected = renderInstanceConfig({ ...base, accountType: "offline" })
		const live = compareInstanceConfig(expected, realConfig).filter(
			(entry) => entry.kind !== "section" && entry.key.startsWith("ChatBot.McpServer."),
		)

		expect(live).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "fixed",
					key: "ChatBot.McpServer.Transport.RequireAuthToken",
					expected: true,
					actual: false,
				}),
				expect.objectContaining({
					kind: "fixed",
					key: "ChatBot.McpServer.Capabilities.ChatAndCommands",
					expected: false,
					actual: true,
				}),
			]),
		)
	})

	it("leaves the endpoint switched off when the operator has not asked for it", () => {
		const expected = renderInstanceConfig({ ...base, accountType: "offline" })
		const live = compareInstanceConfig(expected, realConfig).filter(
			(entry) => entry.kind !== "section" && entry.key === "ChatBot.McpServer.Enabled",
		)

		expect(live).toEqual([])
	})

	it("reports the alias list that document was written before we emptied it", () => {
		const expected = renderInstanceConfig({ ...base, accountType: "offline" })
		const sections = compareInstanceConfig(expected, realConfig).filter(
			(entry) => entry.kind === "section",
		)

		expect(sections).toEqual([
			{ kind: "section", section: "Main.Advanced.AccountList", entries: 2 },
			{ kind: "section", section: "Main.Advanced.ServerList", entries: 2 },
		])
	})

	it("names a managed key an operator changed on the host", () => {
		const expected = renderInstanceConfig(base)
		const actual = expected.replace('Host = "100.83.37.21"', 'Host = "evil.example.net"')
		const drift = compareInstanceConfig(expected, actual)

		expect(drift).toHaveLength(1)
		expect(drift[0]).toMatchObject({
			kind: "managed",
			key: "Main.General.Server.Host",
			actual: "evil.example.net",
		})
	})

	it("calls drift on a safety key by a different name", () => {
		const expected = renderInstanceConfig(base)
		const actual = expected.replace("ExitOnFailure = true", "ExitOnFailure = false")
		const drift = compareInstanceConfig(expected, actual)

		expect(drift[0]?.kind).toBe("fixed")
		expect(drift.every(isSafetyDrift)).toBe(true)
	})

	it("notices a key the host dropped entirely", () => {
		const expected = renderInstanceConfig(base)
		const actual = expected.replace('InternalCmdChar = "slash"\n', "")
		const drift = compareInstanceConfig(expected, actual)

		expect(drift).toHaveLength(1)
		expect(drift[0]).toMatchObject({ kind: "fixed", actual: undefined })
	})

	it("notices an alias list that is no longer empty", () => {
		const expected = renderInstanceConfig(base)
		const actual = expected.replace(
			"[Main.Advanced.AccountList]",
			'[Main.Advanced.AccountList]\nOther = { Login = "TestBot", Password = "-" }',
		)
		const drift = compareInstanceConfig(expected, actual)

		expect(drift).toEqual([{ kind: "section", section: "Main.Advanced.AccountList", entries: 1 }])
		expect(drift.every(isSafetyDrift)).toBe(true)
	})

	it("treats the two spellings of a delay as the same value", () => {
		const expected = renderInstanceConfig(base)
		const actual = expected.replace(
			"Delay = { min = 10.0, max = 10.0 }",
			"Delay = { min = 10, max = 10 }",
		)

		expect(compareInstanceConfig(expected, actual)).toEqual([])
	})

	it("says what changed in words an operator can act on", () => {
		const expected = renderInstanceConfig(base)
		const actual = expected.replace('Host = "100.83.37.21"', 'Host = "elsewhere"')
		const [drift] = compareInstanceConfig(expected, actual)

		expect(drift && describeConfigDrift(drift)).toBe(
			'Main.General.Server.Host is "elsewhere", expected "100.83.37.21"',
		)
	})
})

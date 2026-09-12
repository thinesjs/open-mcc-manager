import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { renderInstanceConfig } from "./config"
import { compareInstanceConfig, describeConfigDrift, isSafetyDrift } from "./config-drift"

const base = {
	accountType: "offline",
	minecraftAccount: "OpenMccBot",
	serverAddress: "100.101.102.103",
	autoRelogRetries: 3,
	autoRelogEnabled: true,
	autoRelogDelaySeconds: { min: 10, max: 10 },
	antiAfkEnabled: false,
	antiAfkIntervalSeconds: { min: 60, max: 60 },
	autoRespawnEnabled: false,
	liveControlEnabled: false,
	liveControlPort: 33333,
	worldDataEnabled: false,
	inventoryDataEnabled: false,
	entityDataEnabled: false,
	advancedKeys: {},
	botConfig: {},
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

	it("agrees with the document the client expanded, apart from the star reminder we pin off", () => {
		const expected = renderInstanceConfig({ ...base, accountType: "offline" })
		const settled = compareInstanceConfig(expected, realConfig).filter(
			(entry) => entry.kind !== "section" && !entry.key.startsWith("ChatBot.McpServer."),
		)

		expect(settled).toEqual([
			{
				kind: "fixed",
				key: "Main.Advanced.ShowGithubStarReminder",
				expected: false,
				actual: true,
			},
			{
				kind: "fixed",
				key: "Main.Advanced.BotOwners",
				expected: [],
				actual: ["player1", "player2"],
			},
			{
				kind: "fixed",
				key: "ChatBot.ChatLog.Log_File",
				expected: "chatlog.txt",
				actual: "chatlog-%username%-%serverip%.txt",
			},
		])
	})

	it("reports each pinned key the host disagrees with, one at a time", () => {
		const expected = renderInstanceConfig(base)
		const cases = [
			{
				key: "Console.General.ConsoleMode",
				from: 'ConsoleMode = "classic"',
				to: 'ConsoleMode = "hidden"',
				want: "hidden",
			},
			{
				key: "Main.Advanced.ShowGithubStarReminder",
				from: "ShowGithubStarReminder = false",
				to: "ShowGithubStarReminder = true",
				want: true,
			},
			{ key: "Logging.LogToFile", from: "LogToFile = false", to: "LogToFile = true", want: true },
		] as const

		for (const probe of cases) {
			expect(expected).toContain(probe.from)
			const actual = expected.replace(probe.from, probe.to)
			const drift = compareInstanceConfig(expected, actual).filter(
				(entry) => entry.kind !== "section",
			)

			expect(drift).toEqual([
				{
					kind: "fixed",
					key: probe.key,
					expected: probe.key === "Console.General.ConsoleMode" ? "classic" : false,
					actual: probe.want,
				},
			])
		}
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
		const actual = expected.replace('Host = "100.101.102.103"', 'Host = "evil.example.net"')
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
		const actual = expected.replace('Host = "100.101.102.103"', 'Host = "elsewhere"')
		const [drift] = compareInstanceConfig(expected, actual)

		expect(drift && describeConfigDrift(drift)).toBe(
			'Main.General.Server.Host is "elsewhere", expected "100.101.102.103"',
		)
	})
})

describe("comparing delay ranges", () => {
	const ranged = {
		...base,
		accountType: "offline",
		autoRelogDelaySeconds: { min: 5, max: 20 },
		antiAfkIntervalSeconds: { min: 90, max: 300 },
	} as const

	it("sees no drift when the host carries the very same distinct range", () => {
		const expected = renderInstanceConfig(ranged)

		expect(compareInstanceConfig(expected, expected)).toEqual([])
	})

	it.each([
		{
			named: "the shortest auto-relog bound",
			from: "{ min = 5.0, max = 20.0 }",
			to: "{ min = 6.0, max = 20.0 }",
			key: "ChatBot.AutoRelog.Delay",
			want: { min: 6, max: 20 },
			expected: { min: 5, max: 20 },
		},
		{
			named: "the longest auto-relog bound",
			from: "{ min = 5.0, max = 20.0 }",
			to: "{ min = 5.0, max = 21.0 }",
			key: "ChatBot.AutoRelog.Delay",
			want: { min: 5, max: 21 },
			expected: { min: 5, max: 20 },
		},
		{
			named: "the shortest anti-AFK bound",
			from: "{ min = 90.0, max = 300.0 }",
			to: "{ min = 91.0, max = 300.0 }",
			key: "ChatBot.AntiAFK.Delay",
			want: { min: 91, max: 300 },
			expected: { min: 90, max: 300 },
		},
		{
			named: "the longest anti-AFK bound",
			from: "{ min = 90.0, max = 300.0 }",
			to: "{ min = 90.0, max = 301.0 }",
			key: "ChatBot.AntiAFK.Delay",
			want: { min: 90, max: 301 },
			expected: { min: 90, max: 300 },
		},
	])("reports drift when the host moves $named", ({ from, to, key, want, expected: wanted }) => {
		const expected = renderInstanceConfig(ranged)
		expect(expected).toContain(from)
		const actual = expected.replace(from, to)

		const drift = compareInstanceConfig(expected, actual).filter(
			(entry) => entry.kind !== "section",
		)

		expect(drift).toEqual([{ kind: "managed", key, expected: wanted, actual: want }])
	})

	it("names both bounds when it tells an operator what a delay drifted to", () => {
		const expected = renderInstanceConfig(ranged)
		const actual = expected.replace("{ min = 5.0, max = 20.0 }", "{ min = 6.0, max = 21.0 }")
		const drift = compareInstanceConfig(expected, actual).filter(
			(entry) => entry.kind !== "section",
		)

		expect(drift.map(describeConfigDrift)).toEqual([
			"ChatBot.AutoRelog.Delay is 6-21, expected 5-20",
		])
	})

	it("reports the pinned player-name check as safety drift when a host turns it off", () => {
		const expected = renderInstanceConfig({ ...base, accountType: "offline" })
		expect(expected).toContain("IgnoreInvalidPlayerName = true")
		const actual = expected.replace(
			"IgnoreInvalidPlayerName = true",
			"IgnoreInvalidPlayerName = false",
		)

		const drift = compareInstanceConfig(expected, actual).filter(
			(entry) => entry.kind !== "section",
		)

		expect(drift).toEqual([
			{
				kind: "fixed",
				key: "Main.Advanced.IgnoreInvalidPlayerName",
				expected: true,
				actual: false,
			},
		])
		expect(drift.every(isSafetyDrift)).toBe(true)
	})
})

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { instanceConfigInput } from "@open-mcc/contracts"
import { parseMccConfig, readMccConfigKeys } from "@open-mcc/contracts/boundary/mcc-config"
import {
	ADVANCED_KEY_NAMES,
	ADVANCED_KEY_SHAPE,
	advancedKeysSchema,
	BOT_CONFIG_NAMES,
	BOT_CONFIG_SHAPE,
	type BotConfig,
	botConfigSchema,
	LIST_CONFIG_NAMES,
} from "@open-mcc/contracts/boundary/mcc-config-keys"
import { describe, expect, it } from "vitest"
import { defaultInstanceConfig, FIXED_CONFIG_KEYS, renderInstanceConfig } from "./config"
import {
	type ConfigDrift,
	compareInstanceConfig,
	isOperatorKey,
	isSafetyDrift,
} from "./config-drift"

const BASE = defaultInstanceConfig({
	accountType: "offline",
	minecraftAccount: "OpenMccBot",
	serverAddress: "100.101.102.103",
})

const SCHEMAS = new Map(Object.entries(BOT_CONFIG_SHAPE))
const ADVANCED = new Map(Object.entries(ADVANCED_KEY_SHAPE))

const CANDIDATES = [
	"true",
	"notes.txt",
	"messages",
	"1",
	"100",
	"1.5",
	"-1.0",
	"0.0",
	"-0.2",
	"single",
	"distance",
	"Interact",
	"blacklist",
	"abort",
	"lookat",
	"index",
	"include",
	"chatlog-%username%-%serverip%.txt",
]

const refusalFor = (name: string, value: string | readonly string[]): readonly string[] => {
	const schema = SCHEMAS.get(name)
	if (schema === undefined) throw new Error(`${name} is not registered`)
	const result = schema.safeParse(value)
	return result.success ? [] : result.error.issues.map((issue) => issue.message)
}

const rendered = (botConfig: BotConfig) => renderInstanceConfig({ ...BASE, botConfig })

const playerListFileDrift = (entry: ConfigDrift): boolean =>
	entry.kind !== "section" && entry.key === "ChatBot.PlayerListLogger.File"

const PATH_FIELDS = [
	"ChatBot.Mailer.DatabaseFile",
	"ChatBot.Mailer.IgnoreListFile",
	"ChatBot.PlayerListLogger.File",
] as const

describe("the settings an operator may change on the client's own bots", () => {
	it("registers the sections that were audited and nothing else", () => {
		const sections = new Set(BOT_CONFIG_NAMES.map((name) => name.split(".")[1]))

		expect([...sections].sort()).toEqual([
			"Alerts",
			"FollowPlayer",
			"Mailer",
			"Map",
			"PlayerListLogger",
			"RemoteControl",
			"ReplayCapture",
		])
	})

	it("shares no key with the generic advanced-key registry, so nothing has two editors", () => {
		expect(BOT_CONFIG_NAMES.filter((name) => ADVANCED_KEY_NAMES.includes(name))).toEqual([])
	})

	it("counts every one of them as the operator's own", () => {
		expect(BOT_CONFIG_NAMES.filter((name) => !isOperatorKey(name))).toEqual([])
	})
})

describe("a file name the operator gives a bot", () => {
	it.each(PATH_FIELDS)("accepts a plain file name on %s", (name) => {
		expect(refusalFor(name, "notes.txt")).toEqual([])
	})

	it.each(PATH_FIELDS)("refuses anything that could leave the instance directory on %s", (name) => {
		for (const outside of ["../secrets", "/etc/passwd", "a/b.txt", "a\\b.txt", "..", "."]) {
			expect(refusalFor(name, outside)).toEqual(["A file name, not a path"])
		}
	})

	it.each(PATH_FIELDS)(
		"★ refuses every variable on %s, because the client could fill one in as a file it already keeps",
		(name) => {
			for (const value of [
				"%username%",
				"%LOGIN%.log",
				"log-%date%.txt",
				"MinecraftClient%serverport%.ini",
				"chatlog-%serverip%.txt",
				"x-%players%.txt",
				"x-%appdata%.txt",
				"logs/%username%.txt",
				"x-%.txt",
			]) {
				expect(refusalFor(name, value)).toEqual(["A file name, not a path"])
			}
		},
	)

	it("★ calls a host that fills the player list file in from a variable a safety failure", () => {
		const expected = rendered({
			"ChatBot.PlayerListLogger.Enabled": "true",
			"ChatBot.PlayerListLogger.File": "mine.txt",
		})
		for (const variable of ["%username%", "%Login%.log", "players-%date%.txt"]) {
			const host = expected.replace('File = "mine.txt"', `File = ${JSON.stringify(variable)}`)
			const drift = compareInstanceConfig(expected, host).filter(playerListFileDrift)

			expect(drift[0]?.kind).toBe("fixed")
		}
	})

	it("still treats a file name the operator chose as their own preference", () => {
		const expected = rendered({
			"ChatBot.PlayerListLogger.Enabled": "true",
			"ChatBot.PlayerListLogger.File": "mine.txt",
		})
		const host = expected.replace('File = "mine.txt"', 'Log_File = "theirs.txt"')
		const drift = compareInstanceConfig(expected, host).filter(playerListFileDrift)

		expect(drift[0]?.kind).toBe("operator")
	})

	it("★ leaves no OTHER bot key whose client default hides a variable we never render", () => {
		const fixture = readFileSync(
			join(__dirname, "../../../contracts/src/boundary/mcc-config-fixture.ini"),
			"utf8",
		)
		const clientDefaults = readMccConfigKeys(fixture, BOT_CONFIG_NAMES).values
		const alwaysRendered = ["ChatBot.PlayerListLogger.File"]

		const hiding = BOT_CONFIG_NAMES.filter((name) => {
			if (alwaysRendered.includes(name)) return false
			const value = clientDefaults.get(name)
			return typeof value === "string" && value.includes("%")
		})

		expect(hiding).toEqual([])
	})

	it("★ refuses a server address that could reach a file name, even though %serverip% is now gone", () => {
		expect(instanceConfigInput.safeParse({ ...BASE, serverAddress: "a/../b" }).success).toBe(false)
	})
})

describe("the words that trigger an alert", () => {
	it("keeps a quoted phrase, which is a legitimate thing to watch for", () => {
		expect(refusalFor("ChatBot.Alerts.Matches", ['say "hello"', "admin"])).toEqual([])
	})

	it.each(["a\nb", "a\rb", ""])("refuses %j, which would break the rendered document", (entry) => {
		expect(refusalFor("ChatBot.Alerts.Matches", [entry])).not.toEqual([])
	})
})

describe("numbers the client would otherwise rewrite", () => {
	it.each([
		{ key: "ChatBot.Mailer.MaxMailsPerPlayer", value: "0", says: "Between 1 and 2147483647" },
		{ key: "ChatBot.PlayerListLogger.Delay", value: "0.5", says: "1 or more" },
		{ key: "ChatBot.FollowPlayer.Update_Limit", value: "-1.0", says: "0 or more" },
		{ key: "ChatBot.FollowPlayer.Stop_At_Distance", value: "-1.0", says: "0 or more" },
		{ key: "ChatBot.ReplayCapture.Backup_Interval", value: "-2.0", says: "-1 or more" },
	])("refuses $value on $key", ({ key, value, says }) => {
		expect(refusalFor(key, value)).toEqual([says])
	})

	it("accepts the replay interval's own off switch, which is negative on purpose", () => {
		expect(refusalFor("ChatBot.ReplayCapture.Backup_Interval", "-1.0")).toEqual([])
	})

	it("accepts a negative fraction, which is why the sign sits before the whole number", () => {
		expect(refusalFor("ChatBot.ReplayCapture.Backup_Interval", "-0.2")).toEqual([])
	})

	it("★ accepts any decimal the client accepts, because nothing here compares float text", () => {
		for (const value of ["1.1234567", "1234567890123456.7", "1.12345678901234567"]) {
			expect(refusalFor("ChatBot.FollowPlayer.Update_Limit", value)).toEqual([])
		}
	})
})

describe("how these settings reach the client's config file", () => {
	it("quotes a file name, which bare would not parse", () => {
		const document = rendered({
			"ChatBot.Mailer.DatabaseFile": "alerts-log.txt",
			"ChatBot.Alerts.Beep_Enabled": "true",
		})

		expect(document).toContain('DatabaseFile = "alerts-log.txt"')
		expect(document).toContain("Beep_Enabled = true")
		expect(() => parseMccConfig(document)).not.toThrow()
	})

	it("leaves a number and a boolean bare, which quoted would change their type", () => {
		const document = rendered({
			"ChatBot.Mailer.MaxMailsPerPlayer": "256",
			"ChatBot.Map.Enabled": "true",
		})

		expect(document).toContain("MaxMailsPerPlayer = 256")
		expect(document).toContain("Enabled = true")
	})

	it("renders the alert words as a list the client can read back", () => {
		const document = rendered({ "ChatBot.Alerts.Matches": ["admin", 'say "hi"'] })

		expect(
			readMccConfigKeys(document, ["ChatBot.Alerts.Matches"]).values.get("ChatBot.Alerts.Matches"),
		).toEqual(["admin", 'say "hi"'])
	})

	it("renders an empty list as an empty list", () => {
		const document = rendered({ "ChatBot.Alerts.Excludes": [] })

		expect(document).toContain("Excludes = []")
		expect(() => parseMccConfig(document)).not.toThrow()
	})

	it("★ puts the pinned map fields and the operator's own under ONE header, which is the only way the document parses", () => {
		const document = rendered({
			"ChatBot.Map.Enabled": "true",
			"ChatBot.Mailer.MaxMailsPerPlayer": "256",
		})
		const headers = document.split("\n").filter((line) => line === "[ChatBot.Map]")

		expect(headers).toHaveLength(1)
		expect(() => parseMccConfig(document)).not.toThrow()
		expect(document).toContain("Send_Rendered_To_Discord = false")
		expect(document).toContain("Send_Rendered_To_Telegram = false")
	})

	it("keeps the two bridge fields pinned off whatever the operator saved", () => {
		expect(FIXED_CONFIG_KEYS).toContain("ChatBot.Map.Send_Rendered_To_Discord")
		expect(FIXED_CONFIG_KEYS).toContain("ChatBot.Map.Send_Rendered_To_Telegram")
	})

	it("survives render, parse and compare with no drift across every value kind", () => {
		const document = rendered({
			"ChatBot.Mailer.DatabaseFile": "alerts-log.txt",
			"ChatBot.Alerts.Matches": ["admin"],
			"ChatBot.Alerts.Beep_Enabled": "false",
			"ChatBot.Mailer.MaxMailsPerPlayer": "256",
			"ChatBot.FollowPlayer.Stop_At_Distance": "3.5",
		})

		expect(compareInstanceConfig(document, document)).toEqual([])
	})
})

describe("when a host changes one of these behind the manager's back", () => {
	it("reports the operator's own setting without carrying the host value out", () => {
		const document = rendered({ "ChatBot.Mailer.MaxMailsPerPlayer": "256" })
		const drift = compareInstanceConfig(
			document,
			document.replace("MaxMailsPerPlayer = 256", "MaxMailsPerPlayer = 64"),
		)

		expect(drift).toEqual([
			{ kind: "operator", key: "ChatBot.Mailer.MaxMailsPerPlayer", expected: 256, actual: 64 },
		])
	})

	it("calls a re-enabled bridge a safety failure, not a preference", () => {
		const document = rendered({})
		const drift = compareInstanceConfig(
			document,
			document.replace("Send_Rendered_To_Discord = false", "Send_Rendered_To_Discord = true"),
		)

		expect(drift).toHaveLength(1)
		expect(drift[0]?.kind).toBe("fixed")
		expect(drift.every(isSafetyDrift)).toBe(true)
	})
})

describe("numbers that would switch a bot off rather than being rewritten", () => {
	it.each([
		"ChatBot.Mailer.MaxMailsPerPlayer",
		"ChatBot.Mailer.MaxDatabaseSize",
		"ChatBot.Mailer.MailRetentionDays",
	])("refuses a non-positive %s, which makes the client disable the mailer entirely", (key) => {
		expect(refusalFor(key, "0")).toEqual(["Between 1 and 2147483647"])
	})

	it("accepts the smallest value the mailer will actually run with", () => {
		expect(refusalFor("ChatBot.Mailer.MaxDatabaseSize", "1")).toEqual([])
	})
})

describe("every registered key at once, which is the only way a table clash shows up", () => {
	const valueFor = (name: string): string | readonly string[] => {
		if (LIST_CONFIG_NAMES.includes(name)) return ["admin", 'say "hi"']
		const schema = SCHEMAS.get(name) ?? ADVANCED.get(name)
		const found = CANDIDATES.find((candidate) => schema?.safeParse(candidate).success === true)
		if (found === undefined) throw new Error(`no candidate value is valid for ${name}`)
		return found
	}

	it("renders, parses, and reads every value back", () => {
		const botConfig: Record<string, string | readonly string[]> = {}
		for (const name of BOT_CONFIG_NAMES) botConfig[name] = valueFor(name)
		for (const name of PATH_FIELDS) botConfig[name] = `${name}.txt`
		const advancedKeys: Record<string, string> = {}
		for (const name of ADVANCED_KEY_NAMES) {
			const value = valueFor(name)
			advancedKeys[name] = typeof value === "string" ? value : ""
		}
		const document = renderInstanceConfig({
			...BASE,
			advancedKeys: advancedKeysSchema.parse(advancedKeys),
			botConfig: botConfigSchema.parse(botConfig),
		})

		expect(() => parseMccConfig(document)).not.toThrow()
		const headers = document.split("\n").filter((line) => line.startsWith("["))
		expect(headers.filter((header, index) => headers.indexOf(header) !== index)).toEqual([])
		const reading = readMccConfigKeys(document, [...BOT_CONFIG_NAMES, ...ADVANCED_KEY_NAMES])
		expect(reading.unreadable).toEqual([])
		expect(reading.values.size).toBe(BOT_CONFIG_NAMES.length + ADVANCED_KEY_NAMES.length)
	})
})

describe("sizes the client itself does not limit", () => {
	it("accepts a file name far longer than any cap this manager once invented", () => {
		expect(refusalFor("ChatBot.Mailer.DatabaseFile", `${"a".repeat(300)}.txt`)).toEqual([])
	})

	it("accepts an alert phrase far longer than any cap this manager once invented", () => {
		expect(refusalFor("ChatBot.Alerts.Matches", ["b".repeat(500)])).toEqual([])
	})

	it("accepts more alert entries than any cap this manager once invented", () => {
		const many = Array.from({ length: 250 }, (_, index) => `word-${index}`)

		expect(refusalFor("ChatBot.Alerts.Excludes", many)).toEqual([])
	})
})

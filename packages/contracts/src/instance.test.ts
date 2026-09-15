import { describe, expect, it } from "vitest"
import {
	ACCOUNT_TYPE_LABELS,
	ACCOUNT_TYPES,
	createInstanceInput,
	INSTANCE_ID_PATTERN,
	instanceConfigInput,
	instanceConfigStored,
	instancePublic,
	isOfflineAccount,
	managerMetricsSchema,
	needsInteractiveSignIn,
} from "./instance"

const VALID_CONFIG = {
	accountType: "offline",
	minecraftAccount: "AfkBot",
	serverAddress: "play.example.com",
	autoRelogRetries: 3,
	autoRelogEnabled: true,
	autoRelogDelaySeconds: { min: 5, max: 20 },
	antiAfkEnabled: true,
	antiAfkIntervalSeconds: { min: 60, max: 90 },
}

describe("instance contracts", () => {
	it("rejects an id carrying a systemd specifier or a path separator", () => {
		expect(INSTANCE_ID_PATTERN.test("V1StGXR8Z5jdHi6B")).toBe(true)
		expect(INSTANCE_ID_PATTERN.test("a%i")).toBe(false)
		expect(INSTANCE_ID_PATTERN.test("a/b")).toBe(false)
		expect(INSTANCE_ID_PATTERN.test("a b")).toBe(false)
		expect(INSTANCE_ID_PATTERN.test("")).toBe(false)
	})

	it("refuses a config write naming a script key, which is what stops config from reaching CSharpRunner", () => {
		const parsed = instanceConfigInput.safeParse({
			...VALID_CONFIG,
			"ChatBot.Script.Script_File": "evil",
		})
		expect(parsed.success).toBe(false)
		expect(JSON.stringify(parsed.error?.issues)).toContain("unrecognized")
	})

	it("refuses any unrecognised key at all, not only script-shaped ones", () => {
		const parsed = instanceConfigInput.safeParse({ ...VALID_CONFIG, harmlessLookingExtra: 1 })
		expect(parsed.success).toBe(false)
		expect(JSON.stringify(parsed.error?.issues)).toContain("unrecognized")
	})

	it("requires a real email for the account the instance logs in as", () => {
		expect(
			createInstanceInput.safeParse({
				hostId: "h1",
				name: "afk-1",
				minecraftAccount: "notanemail",
				serverAddress: "play.example.com",
			}).success,
		).toBe(false)
	})
})

describe("account types", () => {
	it("accepts a bare username for an offline account", () => {
		const parsed = createInstanceInput.safeParse({
			hostId: "h",
			name: "n",
			accountType: "offline",
			minecraftAccount: "OpenMccBot",
			serverAddress: "play.example.net",
		})

		expect(parsed.success).toBe(true)
	})

	it("rejects an email for an offline account, which joins under an in-game name", () => {
		const parsed = createInstanceInput.safeParse({
			hostId: "h",
			name: "n",
			accountType: "offline",
			minecraftAccount: "player@example.com",
			serverAddress: "play.example.net",
		})

		expect(parsed.success).toBe(false)
	})

	it("requires an email for a Microsoft account", () => {
		const parsed = createInstanceInput.safeParse({
			hostId: "h",
			name: "n",
			accountType: "microsoft",
			minecraftAccount: "OpenMccBot",
			serverAddress: "play.example.net",
		})

		expect(parsed.success).toBe(false)
	})

	it("offers only account types whose sign-in the manager can carry out", () => {
		expect([...ACCOUNT_TYPES]).toEqual(["microsoft", "offline"])
	})

	it("separates being offline from skipping the device code, so neither stands in for the other", () => {
		for (const accountType of ACCOUNT_TYPES) {
			expect(isOfflineAccount(accountType)).toBe(!needsInteractiveSignIn(accountType))
		}
	})

	it("names every offered account type", () => {
		for (const accountType of ACCOUNT_TYPES) {
			expect(ACCOUNT_TYPE_LABELS[accountType].length).toBeGreaterThan(0)
		}
	})
})

const PUBLIC_INSTANCE = {
	id: "abc123",
	hostId: "host-1",
	name: "afk-1",
	accountType: "offline",
	minecraftAccount: "AfkBot",
	minecraftUsername: null,
	status: "stopped",
	lastExitCode: null,
}

describe("when an instance was created, as the wire sends it", () => {
	it("requires the ISO string a JSON response carries, not a Date object", () => {
		expect(instancePublic.safeParse({ ...PUBLIC_INSTANCE, createdAt: new Date() }).success).toBe(
			false,
		)
		expect(
			instancePublic.safeParse({ ...PUBLIC_INSTANCE, createdAt: "2026-09-01T00:00:00.000Z" })
				.success,
		).toBe(true)
	})
})

const PUBLIC_METRICS = {
	rssBytes: 1,
	heapUsedBytes: 1,
	heapTotalBytes: 1,
	externalBytes: 1,
	arrayBuffersBytes: 1,
	uptimeSeconds: 1,
}

describe("when a manager metrics sample was taken, as the wire sends it", () => {
	it("requires the ISO string a JSON response carries, not a Date object", () => {
		expect(
			managerMetricsSchema.safeParse({ ...PUBLIC_METRICS, sampledAt: new Date() }).success,
		).toBe(false)
		expect(
			managerMetricsSchema.safeParse({ ...PUBLIC_METRICS, sampledAt: "2026-09-05T00:00:00.000Z" })
				.success,
		).toBe(true)
	})
})

describe("delay ranges on the config write contract", () => {
	it.each([
		{
			named: "a scalar autoRelog delay, the legacy stored shape",
			config: { autoRelogDelaySeconds: 30 },
			path: "autoRelogDelaySeconds",
		},
		{
			named: "a scalar antiAfk interval, the legacy stored shape",
			config: { antiAfkIntervalSeconds: 30 },
			path: "antiAfkIntervalSeconds",
		},
		{
			named: "an array where an autoRelog range belongs",
			config: { autoRelogDelaySeconds: [5, 20] },
			path: "autoRelogDelaySeconds",
		},
		{
			named: "an array where an antiAfk range belongs",
			config: { antiAfkIntervalSeconds: [5, 20] },
			path: "antiAfkIntervalSeconds",
		},
		{
			named: "an omitted autoRelog range",
			config: { autoRelogDelaySeconds: undefined },
			path: "autoRelogDelaySeconds",
		},
		{
			named: "an omitted antiAfk range",
			config: { antiAfkIntervalSeconds: undefined },
			path: "antiAfkIntervalSeconds",
		},
		{
			named: "an omitted autoRelog toggle",
			config: { autoRelogEnabled: undefined },
			path: "autoRelogEnabled",
		},
		{
			named: "an omitted autoRelog min",
			config: { autoRelogDelaySeconds: { max: 20 } },
			path: "autoRelogDelaySeconds.min",
		},
		{
			named: "an omitted autoRelog max",
			config: { autoRelogDelaySeconds: { min: 5 } },
			path: "autoRelogDelaySeconds.max",
		},
		{
			named: "an omitted antiAfk min",
			config: { antiAfkIntervalSeconds: { max: 90 } },
			path: "antiAfkIntervalSeconds.min",
		},
		{
			named: "an omitted antiAfk max",
			config: { antiAfkIntervalSeconds: { min: 60 } },
			path: "antiAfkIntervalSeconds.max",
		},
		{
			named: "a null autoRelog range",
			config: { autoRelogDelaySeconds: null },
			path: "autoRelogDelaySeconds",
		},
		{
			named: "a null antiAfk range",
			config: { antiAfkIntervalSeconds: null },
			path: "antiAfkIntervalSeconds",
		},
		{
			named: "a null autoRelog toggle",
			config: { autoRelogEnabled: null },
			path: "autoRelogEnabled",
		},
		{
			named: "a null autoRelog min",
			config: { autoRelogDelaySeconds: { min: null, max: 20 } },
			path: "autoRelogDelaySeconds.min",
		},
		{
			named: "a null autoRelog max",
			config: { autoRelogDelaySeconds: { min: 5, max: null } },
			path: "autoRelogDelaySeconds.max",
		},
		{
			named: "a null antiAfk min",
			config: { antiAfkIntervalSeconds: { min: null, max: 90 } },
			path: "antiAfkIntervalSeconds.min",
		},
		{
			named: "a null antiAfk max",
			config: { antiAfkIntervalSeconds: { min: 60, max: null } },
			path: "antiAfkIntervalSeconds.max",
		},
		{
			named: "a stringly autoRelog min that would coerce to a valid bound",
			config: { autoRelogDelaySeconds: { min: "5", max: 20 } },
			path: "autoRelogDelaySeconds.min",
		},
		{
			named: "a stringly autoRelog max that would coerce to a valid bound",
			config: { autoRelogDelaySeconds: { min: 5, max: "20" } },
			path: "autoRelogDelaySeconds.max",
		},
		{
			named: "a stringly antiAfk min that would coerce to a valid bound",
			config: { antiAfkIntervalSeconds: { min: "60", max: 90 } },
			path: "antiAfkIntervalSeconds.min",
		},
		{
			named: "a stringly antiAfk max that would coerce to a valid bound",
			config: { antiAfkIntervalSeconds: { min: 60, max: "90" } },
			path: "antiAfkIntervalSeconds.max",
		},
		{
			named: "a stringly toggle that would coerce to a valid boolean",
			config: { autoRelogEnabled: "true" },
			path: "autoRelogEnabled",
		},
		{
			named: "an unknown key inside the autoRelog range",
			config: { autoRelogDelaySeconds: { min: 5, max: 20, step: 1 } },
			path: "autoRelogDelaySeconds",
		},
		{
			named: "an unknown key inside the antiAfk range",
			config: { antiAfkIntervalSeconds: { min: 60, max: 90, step: 1 } },
			path: "antiAfkIntervalSeconds",
		},
		{
			named: "a reversed autoRelog range",
			config: { autoRelogDelaySeconds: { min: 20, max: 5 } },
			path: "autoRelogDelaySeconds",
		},
		{
			named: "a reversed antiAfk range",
			config: { antiAfkIntervalSeconds: { min: 90, max: 60 } },
			path: "antiAfkIntervalSeconds",
		},
		{
			named: "a fractional autoRelog min",
			config: { autoRelogDelaySeconds: { min: 5.5, max: 20 } },
			path: "autoRelogDelaySeconds.min",
		},
		{
			named: "a fractional autoRelog max",
			config: { autoRelogDelaySeconds: { min: 5, max: 20.5 } },
			path: "autoRelogDelaySeconds.max",
		},
		{
			named: "a fractional antiAfk min",
			config: { antiAfkIntervalSeconds: { min: 60.5, max: 90 } },
			path: "antiAfkIntervalSeconds.min",
		},
		{
			named: "a fractional antiAfk max",
			config: { antiAfkIntervalSeconds: { min: 60, max: 90.5 } },
			path: "antiAfkIntervalSeconds.max",
		},
		{
			named: "an infinite autoRelog max",
			config: { autoRelogDelaySeconds: { min: 5, max: Number.POSITIVE_INFINITY } },
			path: "autoRelogDelaySeconds.max",
		},
		{
			named: "an infinite antiAfk max",
			config: { antiAfkIntervalSeconds: { min: 60, max: Number.POSITIVE_INFINITY } },
			path: "antiAfkIntervalSeconds.max",
		},
		{
			named: "an autoRelog min below the floor",
			config: { autoRelogDelaySeconds: { min: 0, max: 20 } },
			path: "autoRelogDelaySeconds.min",
		},
		{
			named: "an autoRelog max above the ceiling",
			config: { autoRelogDelaySeconds: { min: 5, max: 3601 } },
			path: "autoRelogDelaySeconds.max",
		},
		{
			named: "an antiAfk min below the floor",
			config: { antiAfkIntervalSeconds: { min: 0, max: 90 } },
			path: "antiAfkIntervalSeconds.min",
		},
		{
			named: "an antiAfk max above the ceiling",
			config: { antiAfkIntervalSeconds: { min: 60, max: 3601 } },
			path: "antiAfkIntervalSeconds.max",
		},
	])("rejects $named, naming $path", ({ config, path }) => {
		const parsed = instanceConfigInput.safeParse({ ...VALID_CONFIG, ...config })

		expect(parsed.success).toBe(false)
		expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain(path)
	})

	it.each([
		{ named: "distinct bounds on both delays", config: {} },
		{
			named: "equal bounds, so an operator who wants no jitter keeps today's behaviour",
			config: {
				autoRelogDelaySeconds: { min: 10, max: 10 },
				antiAfkIntervalSeconds: { min: 60, max: 60 },
			},
		},
		{
			named: "the floor and the ceiling themselves",
			config: { autoRelogDelaySeconds: { min: 1, max: 3600 } },
		},
		{
			named: "auto-relog switched off, which is a real configuration",
			config: { autoRelogEnabled: false },
		},
	])("accepts $named", ({ config }) => {
		expect(instanceConfigInput.safeParse({ ...VALID_CONFIG, ...config }).success).toBe(true)
	})
})

describe("reading a stored config document", () => {
	it("turns a legacy scalar delay into an equal range, on both delays", () => {
		const parsed = instanceConfigStored.safeParse({
			...VALID_CONFIG,
			autoRelogDelaySeconds: 30,
			antiAfkIntervalSeconds: 60,
		})

		expect(parsed.success).toBe(true)
		expect(parsed.data?.autoRelogDelaySeconds).toEqual({ min: 30, max: 30 })
		expect(parsed.data?.antiAfkIntervalSeconds).toEqual({ min: 60, max: 60 })
	})

	it("reads a document written before the toggle existed as auto-relog on", () => {
		const parsed = instanceConfigStored.safeParse({ ...VALID_CONFIG, autoRelogEnabled: undefined })

		expect(parsed.success).toBe(true)
		expect(parsed.data?.autoRelogEnabled).toBe(true)
	})

	it("reads a document written before advanced keys and bots as holding neither, not as holding nothing", () => {
		const parsed = instanceConfigStored.safeParse(VALID_CONFIG)

		expect(parsed.data?.advancedKeys).toEqual({})
		expect(parsed.data?.botConfig).toEqual({})
	})

	it("passes a canonical document through unchanged", () => {
		const parsed = instanceConfigStored.safeParse({ ...VALID_CONFIG, autoRelogEnabled: false })

		expect(parsed.data?.autoRelogDelaySeconds).toEqual({ min: 5, max: 20 })
		expect(parsed.data?.autoRelogEnabled).toBe(false)
	})

	it.each([
		{
			named: "a bot file name the client already uses",
			botConfig: { "ChatBot.PlayerListLogger.File": "SessionCache.db" },
		},
		{
			named: "a bot file another bot already writes",
			botConfig: { "ChatBot.Mailer.DatabaseFile": "playerlog.txt" },
		},
		{
			named: "a player list file whoever fills the tab list would name",
			botConfig: { "ChatBot.PlayerListLogger.File": "chatlog-%players%.txt" },
		},
	])("★ still READS $named, saved before it was refused, so it stays fixable", ({ botConfig }) => {
		const legacy = { ...VALID_CONFIG, botConfig }

		expect(instanceConfigStored.safeParse(legacy).success).toBe(true)
		expect(instanceConfigInput.safeParse(legacy).success).toBe(false)
	})

	it.each([
		{ named: "an unknown key at the top level", config: { harmlessLookingExtra: 1 } },
		{
			named: "an unknown key inside a range, since strictness is not recursive",
			config: { autoRelogDelaySeconds: { min: 5, max: 20, step: 1 } },
		},
		{ named: "a reversed range", config: { autoRelogDelaySeconds: { min: 20, max: 5 } } },
		{
			named: "a scalar delay outside the bounds a single value had",
			config: { autoRelogDelaySeconds: 3601 },
		},
	])("stays strict about $named", ({ config }) => {
		expect(instanceConfigStored.safeParse({ ...VALID_CONFIG, ...config }).success).toBe(false)
	})
})

describe("★ what stops a client filename escaping the instance directory once the client expands it", () => {
	it.each([
		"play.example.com/../../etc",
		"play.example.com\\..\\etc",
		"../play.example.com",
		"play.example\u0000com",
	])("refuses the server address %j, which %%serverip%% would carry into a file name", (value) => {
		expect(instanceConfigInput.safeParse({ ...VALID_CONFIG, serverAddress: value }).success).toBe(
			false,
		)
		expect(
			createInstanceInput.safeParse({
				hostId: "h1",
				name: "n",
				accountType: "offline",
				minecraftAccount: "AfkBot",
				serverAddress: value,
			}).success,
		).toBe(false)
	})

	it.each(["Afk/Bot", "Afk\\Bot", "..", "Afk..Bot"])(
		"refuses the account %j, which %%username%% and %%login%% would carry into a file name",
		(value) => {
			expect(
				instanceConfigInput.safeParse({ ...VALID_CONFIG, minecraftAccount: value }).success,
			).toBe(false)
		},
	)

	it("★ still READS a document saved before that rule, so a bad value stays fixable", () => {
		const legacy = { ...VALID_CONFIG, serverAddress: "play.example.com/../etc" }

		expect(instanceConfigStored.safeParse(legacy).success).toBe(true)
		expect(instanceConfigInput.safeParse(legacy).success).toBe(false)
	})

	it("★ still READS a player list file named by a variable before that rule, so it stays fixable", () => {
		const legacy = { ...VALID_CONFIG, botConfig: { "ChatBot.PlayerListLogger.File": "%username%" } }

		expect(instanceConfigStored.safeParse(legacy).success).toBe(true)
		expect(instanceConfigInput.safeParse(legacy).success).toBe(false)
	})

	it("still accepts the ordinary address and account an operator actually types", () => {
		expect(
			instanceConfigInput.safeParse({
				...VALID_CONFIG,
				serverAddress: "play.example.com:25565",
				minecraftAccount: "AfkBot_01",
			}).success,
		).toBe(true)
	})
})

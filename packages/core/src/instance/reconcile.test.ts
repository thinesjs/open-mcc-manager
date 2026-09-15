import { createServer, type Server } from "node:http"
import { connect } from "node:net"
import type { InstanceRow, InstanceScheduleRow } from "@open-mcc/db"
import {
	createFakeTransport,
	type FakeFailures,
	READ_CONNECTION_HARD_AGE_MS,
	readerOver,
} from "@open-mcc/transport"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CONNECT_TIMEOUT_MS } from "../host/host.controller"
import { renderUnitTemplates } from "../host/unit-template"
import { renderInstanceConfig } from "./config"
import {
	desiredStateIsSatisfied,
	expectedUnits,
	isManagedUnit,
	looksStuck,
	parseObservedState,
	playerNameFrom,
	RECONCILE_DEADLINE_MS,
	reconcileFactsCommand,
	reconcileHostOverTransport,
	renderScheduleUnits,
	STUCK_MARKERS,
	unitRuntimeFor,
	WITHHELD_VALUE,
} from "./reconcile"

const UNIT_RUNTIME = {
	networkStack: "slirp4netns",
	imageId: "b54641a0139b45834e25e82fa2cf2be60bafa6a1b6a22868bb1df7182a27a7b9",
} as const

const instance = (overrides: Partial<InstanceRow> = {}): InstanceRow => ({
	id: "abc123",
	organizationId: "org-1",
	hostId: "host-1",
	name: "afk-1",
	accountType: "microsoft",
	liveControlPort: 33333,
	liveControlTokenEncrypted: null,
	liveControlTokenKeyId: null,
	minecraftAccount: "afk@example.com",
	minecraftUsername: null,
	status: "running",
	lastExitCode: null,
	authClaimId: null,
	authClaimedAt: null,
	playerListOffset: "0",
	playerListFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	playerListCursorVersion: "0",
	createdAt: new Date(),
	...overrides,
})

const schedule = (overrides: Partial<InstanceScheduleRow> = {}): InstanceScheduleRow => ({
	id: "sched-1",
	organizationId: "org-1",
	instanceId: "abc123",
	daysOfWeek: "Mon,Tue",
	stopMinuteOfDay: 1130,
	startMinuteOfDay: 1170,
	timezone: "Asia/Kuala_Lumpur",
	enabled: true,
	createdAt: new Date(),
	...overrides,
})

type Script = Record<string, { stdout: string; stderr: string; exitCode: number }>

const opened = async (script: Script, failures: FakeFailures = {}) => {
	const transport = createFakeTransport(script, failures)
	await transport.connect({
		hostname: "h",
		port: 22,
		username: "root",
		privateKey: "k",
		expectedFingerprint: "f",
		timeoutMs: 1000,
	})
	return { transport, reader: await readerOver(transport) }
}

const connected = async (script: Script, failures: FakeFailures = {}) =>
	(await opened(script, failures)).reader

const FACTS = reconcileFactsCommand(UNIT_RUNTIME.imageId)

type HostState = {
	units: readonly string[]
	version: string
	containers: readonly string[]
	image: string
}

const HEALTHY: HostState = {
	units: [],
	version: "podman version 4.3.1",
	containers: [],
	image: "0",
}

const factsOutput = (state: HostState): string =>
	[
		"open-mcc/units",
		...state.units,
		"open-mcc/podman",
		state.version,
		"open-mcc/containers",
		...state.containers,
		"open-mcc/image",
		state.image,
		"open-mcc/end",
		"",
	].join("\n")

const factsReply = (state: Partial<HostState> = {}) => ({
	[FACTS]: { stdout: factsOutput({ ...HEALTHY, ...state }), stderr: "", exitCode: 0 },
})

const UNIT_ENV = `cat "$HOME"/.local/share/open-mcc/instances/abc123/unit.env 2>/dev/null || printf '%s' '__open_mcc_missing__'`

const hostReplies = (units: Map<string, string>): Script => ({
	...Object.fromEntries(
		[...units].map(([name, contents]) => [
			`cat "$HOME"/.config/systemd/user/'${name}' 2>/dev/null || printf '%s' '__open_mcc_missing__'`,
			{ stdout: contents, stderr: "", exitCode: 0 },
		]),
	),
	...factsReply({ units: [...units.keys()] }),
	[UNIT_ENV]: { stdout: "OPEN_MCC_PORT=33333\n", stderr: "", exitCode: 0 },
})

describe("observed state", () => {
	it("maps what systemctl is-active actually prints", () => {
		expect(parseObservedState("active\n")).toBe("active")
		expect(parseObservedState("failed")).toBe("failed")
	})

	it("treats anything it does not recognise as unknown rather than guessing", () => {
		expect(parseObservedState("")).toBe("unknown")
		expect(parseObservedState("something-new")).toBe("unknown")
	})

	it("accepts activating as satisfying a desired running state, since it is on its way", () => {
		expect(desiredStateIsSatisfied("running", "activating")).toBe(true)
		expect(desiredStateIsSatisfied("running", "inactive")).toBe(false)
		expect(desiredStateIsSatisfied("stopped", "active")).toBe(false)
	})

	it("does not judge an instance that is mid-authentication", () => {
		expect(desiredStateIsSatisfied("needs_auth", "inactive")).toBe(true)
		expect(desiredStateIsSatisfied("needs_auth", "active")).toBe(true)
	})
})

describe("expected units", () => {
	it("expects every shipped template even when no schedule exists", () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		for (const name of Object.keys(renderUnitTemplates(UNIT_RUNTIME)))
			expect(expected.has(name)).toBe(true)
	})

	it("expects a schedule's timers only for an instance that still exists", () => {
		const orphan = schedule({ instanceId: "gone" })
		const expected = expectedUnits([instance()], [orphan], renderScheduleUnits, UNIT_RUNTIME)
		expect([...expected.keys()].some((name) => name.includes("gone"))).toBe(false)
	})

	it("expects both timers for a scheduled instance", () => {
		const expected = expectedUnits([instance()], [schedule()], renderScheduleUnits, UNIT_RUNTIME)
		expect(expected.has("open-mcc-sleep-stop@abc123.timer")).toBe(true)
		expect(expected.has("open-mcc-sleep-start@abc123.timer")).toBe(true)
	})
})

describe("the runtime the units are rendered for", () => {
	it("comes from the recorded network stack and the image pinned for the recorded architecture", () => {
		expect(unitRuntimeFor({ networkStack: "pasta", architecture: "arm64" })).toEqual({
			networkStack: "pasta",
			imageId: "b54641a0139b45834e25e82fa2cf2be60bafa6a1b6a22868bb1df7182a27a7b9",
		})
		expect(unitRuntimeFor({ networkStack: "slirp4netns", architecture: "x64" })).toEqual({
			networkStack: "slirp4netns",
			imageId: "56e3d8542b4091c81816101e95875e32ec981577e669112c479a57d4003e4c29",
		})
	})
})

describe("reconciling a host", () => {
	it("reports no drift when every unit matches and the state agrees", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const transport = await connected({
			...hostReplies(expected),
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "active",
					stderr: "",
					exitCode: 0,
				},
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
		)

		expect(result).toEqual({
			hostId: "host-1",
			reachable: true,
			runtimeDrift: [],
			unitDrift: [],
			stateDrift: [],
			configDrift: [],
		})
	})

	it("distinguishes a unit that is absent from one whose content has changed", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const replies = hostReplies(expected)
		const names = [...expected.keys()]
		const missing = names[0] ?? ""
		const changed = names[1] ?? ""
		replies[
			`cat "$HOME"/.config/systemd/user/'${missing}' 2>/dev/null || printf '%s' '__open_mcc_missing__'`
		] = { stdout: "__open_mcc_missing__", stderr: "", exitCode: 0 }
		replies[
			`cat "$HOME"/.config/systemd/user/'${changed}' 2>/dev/null || printf '%s' '__open_mcc_missing__'`
		] = { stdout: "edited by hand", stderr: "", exitCode: 0 }

		const transport = await connected({
			...replies,
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "active",
					stderr: "",
					exitCode: 0,
				},
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
		)
		if (!result.reachable) throw new Error("expected a reachable host")

		expect(result.unitDrift).toContainEqual({ kind: "missing", unit: missing })
		expect(result.unitDrift).toContainEqual({ kind: "differs", unit: changed })
	})

	it("reports an instance the manager believes is running but the host has stopped", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const transport = await connected({
			...hostReplies(expected),
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "inactive",
					stderr: "",
					exitCode: 3,
				},
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
		)
		if (!result.reachable) throw new Error("expected a reachable host")

		expect(result.stateDrift).toEqual([
			{ instanceId: "abc123", desired: "running", observed: "inactive" },
		])
	})
})

describe("units the manager does not define", () => {
	it("recognises only the units this manager installs", () => {
		expect(isManagedUnit("open-mcc@abc.service")).toBe(true)
		expect(isManagedUnit("open-mcc@.service")).toBe(true)
		expect(isManagedUnit("open-mcc-sleep-stop@abc.timer")).toBe(true)
		expect(isManagedUnit("nginx.service")).toBe(false)
		expect(isManagedUnit("open-mcc-manager-backup.service")).toBe(false)
	})

	it("ignores an administrator's backup of one of our units, which we did not install", () => {
		for (const name of [
			"open-mcc@.service.bak",
			"open-mcc@abc.service.dpkg-old",
			"open-mcc@abc.service~",
			"open-mcc@abc.socket",
		]) {
			expect(isManagedUnit(name)).toBe(false)
		}
	})

	it("reports a timer left behind for an instance that no longer exists", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const transport = await connected({
			...hostReplies(expected),
			...factsReply({ units: [...expected.keys(), "open-mcc-sleep-stop@deleted1.timer"] }),
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "active",
					stderr: "",
					exitCode: 0,
				},
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
		)
		if (!result.reachable) throw new Error("expected a reachable host")

		expect(result.unitDrift).toEqual([
			{ kind: "unexpected", unit: "open-mcc-sleep-stop@deleted1.timer" },
		])
	})

	it("leaves unrelated units on the host alone, which are none of its business", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const transport = await connected({
			...hostReplies(expected),
			...factsReply({
				units: [...expected.keys(), "nginx.service", "ssh.service", "cron.service"],
			}),
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "active",
					stderr: "",
					exitCode: 0,
				},
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
		)
		if (!result.reachable) throw new Error("expected a reachable host")

		expect(result.unitDrift).toEqual([])
	})

	it("reports another organization's timer on a shared host, which the trust model allows", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const transport = await connected({
			...hostReplies(expected),
			...factsReply({ units: [...expected.keys(), "open-mcc-sleep-stop@otherorg1.timer"] }),
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "active",
					stderr: "",
					exitCode: 0,
				},
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
		)
		if (!result.reachable) throw new Error("expected a reachable host")

		expect(result.unitDrift).toEqual([
			{ kind: "unexpected", unit: "open-mcc-sleep-stop@otherorg1.timer" },
		])
	})

	it("treats a failed listing as unknown rather than as a host with nothing extra", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const transport = await connected({
			...hostReplies(expected),
			[FACTS]: {
				stdout: "open-mcc/units\n",
				stderr: "Permission denied",
				exitCode: 2,
			},
		})

		await expect(
			reconcileHostOverTransport(transport, "host-1", UNIT_RUNTIME, [instance()], expected),
		).rejects.toThrow(/Permission denied/)
	})
})

describe("a client that is running but not doing anything", () => {
	const journalFor = (text: string) => ({
		"XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u 'open-mcc@abc123.service' --lines 20 --no-pager --output cat 2>/dev/null || true":
			{ stdout: text, stderr: "", exitCode: 0 },
	})

	it("recognises the lines the real client prints when it is stuck", () => {
		expect(looksStuck('Failed to parse the settings file, enter "/new" to generate')).toBe(true)
		expect(looksStuck("[MCC] Not connected to any server. Use '/help' for help.")).toBe(true)
		expect(looksStuck("Or press Enter to exit Minecraft Console Client.")).toBe(true)
		expect(looksStuck("Server version:")).toBe(true)
	})

	it("does not call a healthy journal stuck", () => {
		expect(looksStuck("[MCC] Server was successfully joined.\n<player> hello")).toBe(false)
		expect(looksStuck("")).toBe(false)
	})

	it("never treats stuck as satisfying any desired state", () => {
		expect(desiredStateIsSatisfied("running", "stuck")).toBe(false)
		expect(desiredStateIsSatisfied("stopped", "stuck")).toBe(false)
		expect(desiredStateIsSatisfied("needs_auth", "stuck")).toBe(false)
	})

	it("reports drift for a unit systemd calls active whose client is wedged", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const transport = await connected({
			...hostReplies(expected),
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "active",
					stderr: "",
					exitCode: 0,
				},
			...journalFor('Failed to parse the settings file, enter "/new" to generate'),
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
		)
		if (!result.reachable) throw new Error("expected a reachable host")

		expect(result.stateDrift).toEqual([
			{ instanceId: "abc123", desired: "running", observed: "stuck" },
		])
	})

	it("leaves a genuinely healthy instance alone", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const transport = await connected({
			...hostReplies(expected),
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "active",
					stderr: "",
					exitCode: 0,
				},
			...journalFor("[MCC] Server was successfully joined."),
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
		)
		if (!result.reachable) throw new Error("expected a reachable host")

		expect(result.stateDrift).toEqual([])
	})
})

describe("noticing which account an instance is signed in as", () => {
	it("reads the name from the line the client prints when it loads a cached session", () => {
		expect(playerNameFrom("Cached session is still valid for Notch.")).toBe("Notch")
	})

	it("reports nothing when the client has not said who it is", () => {
		expect(playerNameFrom("MCC is running with default settings.")).toBeUndefined()
	})

	it("accepts only names Minecraft itself would allow, so nothing else is captured", () => {
		expect(playerNameFrom("Cached session is still valid for a.")).toBeUndefined()
		expect(playerNameFrom("Cached session is still valid for has space.")).toBeUndefined()
		expect(playerNameFrom("Cached session is still valid for Player_123.")).toBe("Player_123")
	})
})

describe("recognising a client that is stuck", () => {
	const joinedJournal = [
		"[MCC] Version is supported.",
		"Logging in...",
		"Retrieving Server Info...",
		"Server version: Paper 26.2 (protocol v776)",
		"[MCC] Server is in offline mode.",
		"[MCC] Server was successfully joined.",
		"Type '/quit' to leave the server.",
		"OpenMccBot joined the game",
	].join("\n")

	it("does not call a connected client stuck just because it printed the server version", () => {
		expect(looksStuck(joinedJournal)).toBe(false)
	})

	it("calls a client stuck when it read the server version but never joined", () => {
		const halted = [
			"Retrieving Server Info...",
			"Server version: Paper 26.2 (protocol v776)",
			"Logging in...",
		].join("\n")

		expect(looksStuck(halted)).toBe(true)
	})

	it("calls a client stuck on each marker that means it gave up", () => {
		for (const marker of STUCK_MARKERS) {
			expect(looksStuck(`some output\n${marker}\nmore output`)).toBe(true)
		}
	})

	it("says nothing about a journal that has scrolled past both markers", () => {
		expect(looksStuck("OpenMccBot joined the game\n<someone> hello")).toBe(false)
	})

	it("ignores a marker that arrived as server chat, which anyone on the server can send", () => {
		const hostile = [
			"[MCC] Server was successfully joined.",
			"\u258c<griefer> Not connected to any server",
		].join("\n")

		expect(looksStuck(hostile)).toBe(false)
	})

	it("still trusts a marker the client emitted itself", () => {
		expect(looksStuck("Not connected to any server")).toBe(true)
	})

	it("does not let chat hide a genuine failure to join", () => {
		const halted = ["Server version: Paper 26.2", "\u258c<player> hello"].join("\n")

		expect(looksStuck(halted)).toBe(true)
	})
})

describe("comparing a host's client config", () => {
	it("reads each instance's config off the host and names a key that drifted", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const document = renderInstanceConfig({
			accountType: "offline",
			minecraftAccount: "Steve",
			serverAddress: "play.example.net",
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
		})
		const transport = await connected({
			...hostReplies(expected),
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "active",
					stderr: "",
					exitCode: 0,
				},
			'cat "$HOME"/.local/share/open-mcc/instances/abc123/config/MinecraftClient.ini 2>/dev/null || true':
				{
					stdout: document.replace('Host = "play.example.net"', 'Host = "elsewhere.example"'),
					stderr: "",
					exitCode: 0,
				},
		})

		const { reconciliation } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
			new Map([["abc123", document]]),
		)

		if (!reconciliation.reachable) throw new Error("expected a reachable host")
		expect(reconciliation.configDrift).toEqual([
			{
				instanceId: "abc123",
				kind: "managed",
				key: "Main.General.Server.Host",
				expected: "play.example.net",
				actual: "elsewhere.example",
			},
		])
	})

	it("shows an operator both bounds of a drifted delay, never the object itself", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const document = renderInstanceConfig({
			accountType: "offline",
			minecraftAccount: "Steve",
			serverAddress: "play.example.net",
			autoRelogRetries: 3,
			autoRelogEnabled: true,
			autoRelogDelaySeconds: { min: 5, max: 20 },
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
		})
		const transport = await connected({
			...hostReplies(expected),
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "active",
					stderr: "",
					exitCode: 0,
				},
			'cat "$HOME"/.local/share/open-mcc/instances/abc123/config/MinecraftClient.ini 2>/dev/null || true':
				{
					stdout: document.replace("{ min = 5.0, max = 20.0 }", "{ min = 7.0, max = 30.0 }"),
					stderr: "",
					exitCode: 0,
				},
		})

		const { reconciliation } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
			new Map([["abc123", document]]),
		)

		if (!reconciliation.reachable) throw new Error("expected a reachable host")
		expect(reconciliation.configDrift).toEqual([
			{
				instanceId: "abc123",
				kind: "managed",
				key: "ChatBot.AutoRelog.Delay",
				expected: "5-20",
				actual: "7-30",
			},
		])
	})

	it("says the config is missing rather than reporting every key as drifted", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const transport = await connected({
			...hostReplies(expected),
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "active",
					stderr: "",
					exitCode: 0,
				},
		})

		const { reconciliation } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
			new Map([["abc123", '[Main.General]\nAccountType = "microsoft"\n']]),
		)

		if (!reconciliation.reachable) throw new Error("expected a reachable host")
		expect(reconciliation.configDrift).toHaveLength(1)
		expect(reconciliation.configDrift[0]?.actual).toBeNull()
	})

	it("★ withholds the host's own value even when the drift is a SAFETY one on an operator key", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const document = renderInstanceConfig({
			accountType: "offline",
			minecraftAccount: "Steve",
			serverAddress: "play.example.net",
			autoRelogRetries: 3,
			autoRelogEnabled: true,
			autoRelogDelaySeconds: { min: 5, max: 20 },
			antiAfkEnabled: true,
			antiAfkIntervalSeconds: { min: 90, max: 300 },
			autoRespawnEnabled: false,
			liveControlEnabled: false,
			liveControlPort: 33333,
			worldDataEnabled: false,
			inventoryDataEnabled: false,
			entityDataEnabled: false,
			advancedKeys: {},
			botConfig: {
				"ChatBot.PlayerListLogger.Enabled": "true",
				"ChatBot.PlayerListLogger.File": "playerlist.txt",
			},
		})
		const transport = await connected({
			...hostReplies(expected),
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "active",
					stderr: "",
					exitCode: 0,
				},
			'cat "$HOME"/.local/share/open-mcc/instances/abc123/config/MinecraftClient.ini 2>/dev/null || true':
				{
					stdout: document.replace('File = "playerlist.txt"', 'File = "players-%serverip%.txt"'),
					stderr: "",
					exitCode: 0,
				},
		})

		const { reconciliation } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
			new Map([["abc123", document]]),
		)

		if (!reconciliation.reachable) throw new Error("expected a reachable host")
		const entry = reconciliation.configDrift.find(
			(each) => each.key === "ChatBot.PlayerListLogger.File",
		)
		expect(entry?.kind).toBe("fixed")
		expect(entry?.actual).toBe(WITHHELD_VALUE)
		expect(JSON.stringify(entry)).not.toContain("serverip")
	})

	it("★ never puts a password the host holds into the browser", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const document = renderInstanceConfig({
			accountType: "offline",
			minecraftAccount: "Steve",
			serverAddress: "play.example.net",
			autoRelogRetries: 3,
			autoRelogEnabled: true,
			autoRelogDelaySeconds: { min: 5, max: 20 },
			antiAfkEnabled: true,
			antiAfkIntervalSeconds: { min: 90, max: 300 },
			autoRespawnEnabled: false,
			liveControlEnabled: false,
			liveControlPort: 33333,
			worldDataEnabled: false,
			inventoryDataEnabled: false,
			entityDataEnabled: false,
			advancedKeys: {},
			botConfig: {},
		})
		const transport = await connected({
			...hostReplies(expected),
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "active",
					stderr: "",
					exitCode: 0,
				},
			'cat "$HOME"/.local/share/open-mcc/instances/abc123/config/MinecraftClient.ini 2>/dev/null || true':
				{
					stdout: document.replace('Password = "-"', 'Password = "hunter2"'),
					stderr: "",
					exitCode: 0,
				},
		})

		const { reconciliation } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
			new Map([["abc123", document]]),
		)

		if (!reconciliation.reachable) throw new Error("expected a reachable host")
		const entry = reconciliation.configDrift.find(
			(each) => each.key === "Main.General.Account.Password",
		)
		expect(entry?.actual).toBe(WITHHELD_VALUE)
		expect(JSON.stringify(reconciliation.configDrift)).not.toContain("hunter2")
	})

	it("withholds the host's own value when a key the operator saved has drifted", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const document = renderInstanceConfig({
			accountType: "microsoft",
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com:25566",
			autoRelogRetries: 3,
			autoRelogEnabled: true,
			autoRelogDelaySeconds: { min: 5, max: 20 },
			antiAfkEnabled: true,
			antiAfkIntervalSeconds: { min: 90, max: 300 },
			autoRespawnEnabled: false,
			liveControlEnabled: false,
			liveControlPort: 33333,
			worldDataEnabled: false,
			inventoryDataEnabled: false,
			entityDataEnabled: false,
			advancedKeys: { "ChatBot.AutoAttack.Mode": "single" },
			botConfig: {},
		})
		const transport = await connected({
			...hostReplies(expected),
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "active",
					stderr: "",
					exitCode: 0,
				},
			'cat "$HOME"/.local/share/open-mcc/instances/abc123/config/MinecraftClient.ini 2>/dev/null || true':
				{
					stdout: document.replace('Mode = "single"', 'Mode = "10.0.0.7:25565 hunter2"'),
					stderr: "",
					exitCode: 0,
				},
		})

		const { reconciliation } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
			new Map([["abc123", document]]),
		)

		if (!reconciliation.reachable) throw new Error("expected a reachable host")
		expect(reconciliation.configDrift).toEqual([
			{
				instanceId: "abc123",
				kind: "operator",
				key: "ChatBot.AutoAttack.Mode",
				expected: "single",
				actual: null,
			},
		])
		const serialised = JSON.stringify(reconciliation.configDrift)
		expect(serialised).not.toContain("10.0.0.7")
		expect(serialised).not.toContain("25565")
		expect(serialised).not.toContain("hunter2")
	})

	it("reports a live control endpoint that never claimed its port", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const document = renderInstanceConfig({
			accountType: "offline",
			minecraftAccount: "Steve",
			serverAddress: "play.example.net",
			autoRelogRetries: 3,
			autoRelogEnabled: true,
			autoRelogDelaySeconds: { min: 10, max: 10 },
			antiAfkEnabled: false,
			antiAfkIntervalSeconds: { min: 60, max: 60 },
			autoRespawnEnabled: false,
			liveControlEnabled: true,
			liveControlPort: 33401,
			worldDataEnabled: false,
			inventoryDataEnabled: false,
			entityDataEnabled: false,
			advancedKeys: {},
			botConfig: {},
		})
		const transport = await connected(
			{
				...hostReplies(expected),
				"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
					{
						stdout: "active",
						stderr: "",
						exitCode: 0,
					},
				[`XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u 'open-mcc@abc123.service' --lines 20 --no-pager --output cat 2>/dev/null || true`]:
					{ stdout: "[MCC] Server was successfully joined.", stderr: "", exitCode: 0 },
				'cat "$HOME"/.local/share/open-mcc/instances/abc123/config/MinecraftClient.ini 2>/dev/null || true':
					{
						stdout: document,
						stderr: "",
						exitCode: 0,
					},
			},
			{ refusePorts: [33401] },
		)

		const { reconciliation } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
			new Map([["abc123", document]]),
		)

		if (!reconciliation.reachable) throw new Error("expected a reachable host")
		expect(reconciliation.configDrift).toEqual([
			{
				instanceId: "abc123",
				kind: "unreachable",
				key: "ChatBot.McpServer",
				expected: "33401",
				actual: null,
			},
		])
	})

	it("says nothing about live control before the client has joined a server", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const document = renderInstanceConfig({
			accountType: "offline",
			minecraftAccount: "Steve",
			serverAddress: "play.example.net",
			autoRelogRetries: 3,
			autoRelogEnabled: true,
			autoRelogDelaySeconds: { min: 10, max: 10 },
			antiAfkEnabled: false,
			antiAfkIntervalSeconds: { min: 60, max: 60 },
			autoRespawnEnabled: false,
			liveControlEnabled: true,
			liveControlPort: 33401,
			worldDataEnabled: false,
			inventoryDataEnabled: false,
			entityDataEnabled: false,
			advancedKeys: {},
			botConfig: {},
		})
		const transport = await connected({
			...hostReplies(expected),
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true":
				{
					stdout: "active",
					stderr: "",
					exitCode: 0,
				},
			'cat "$HOME"/.local/share/open-mcc/instances/abc123/config/MinecraftClient.ini 2>/dev/null || true':
				{
					stdout: document,
					stderr: "",
					exitCode: 0,
				},
		})

		const { reconciliation } = await reconcileHostOverTransport(
			transport,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
			new Map([["abc123", document]]),
		)

		if (!reconciliation.reachable) throw new Error("expected a reachable host")
		expect(reconciliation.configDrift).toEqual([])
	})
})

describe("how long a setup check may run on a shared connection", () => {
	it("ends before the connection's hard age even after a full connect, so a check can always fit", () => {
		expect(RECONCILE_DEADLINE_MS).toBeLessThan(READ_CONNECTION_HARD_AGE_MS - CONNECT_TIMEOUT_MS)
	})
})

const IS_ACTIVE =
	"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active 'open-mcc@abc123.service' || true"

const JOURNAL =
	"XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u 'open-mcc@abc123.service' --lines 20 --no-pager --output cat 2>/dev/null || true"

const CONFIG =
	'cat "$HOME"/.local/share/open-mcc/instances/abc123/config/MinecraftClient.ini 2>/dev/null || true'

const reply = (stdout: string, exitCode = 0) => ({ stdout, stderr: "", exitCode })

describe("reading a Podman host in one command", () => {
	it("reads the unit listing, the Podman version, the container names and the image in one command", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const { transport, reader } = await opened({
			...hostReplies(expected),
			[IS_ACTIVE]: reply("active"),
		})

		await reconcileHostOverTransport(reader, "host-1", UNIT_RUNTIME, [instance()], expected)

		const facts = transport.commands.filter(
			(command) => command.includes("podman") || command.includes("ls -1"),
		)
		expect(facts).toHaveLength(1)
		expect(facts.at(0)).toContain('ls -1 "$HOME"/.config/systemd/user')
		expect(facts.at(0)).toContain("podman --version")
		expect(facts.at(0)).toContain("podman ps -a --format '{{.Names}}'")
		expect(facts.at(0)).toContain(`podman image exists '${UNIT_RUNTIME.imageId}'`)
	})

	it("reports a container left for an instance it does not know, and not a known stopped instance's own", async () => {
		const stopped = instance({ status: "stopped" })
		const expected = expectedUnits([stopped], [], renderScheduleUnits, UNIT_RUNTIME)
		const reader = await connected({
			...hostReplies(expected),
			...factsReply({
				units: [...expected.keys()],
				containers: [
					"open-mcc-abc123",
					"open-mcc-auth-abc123",
					"open-mcc-deleted1",
					"open-mcc-auth-deleted2",
					"nginx",
					"web-open-mcc-abc123",
				],
			}),
			[IS_ACTIVE]: reply("inactive", 3),
		})

		const { reconciliation } = await reconcileHostOverTransport(
			reader,
			"host-1",
			UNIT_RUNTIME,
			[stopped],
			expected,
		)

		if (!reconciliation.reachable) throw new Error("expected a reachable host")
		expect(reconciliation.stateDrift).toEqual([])
		expect(reconciliation.unitDrift).toEqual([
			{ kind: "unexpected", unit: "open-mcc-deleted1" },
			{ kind: "unexpected", unit: "open-mcc-auth-deleted2" },
		])
	})

	it("reports the runtime image as missing, labelled like a missing unit", async () => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const reader = await connected({
			...hostReplies(expected),
			...factsReply({ units: [...expected.keys()], image: "1" }),
			[IS_ACTIVE]: reply("active"),
		})

		const { reconciliation } = await reconcileHostOverTransport(
			reader,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
		)

		if (!reconciliation.reachable) throw new Error("expected a reachable host")
		expect(reconciliation.unitDrift).toEqual([
			{ kind: "missing", unit: "mcr.microsoft.com/dotnet/runtime-deps" },
		])
	})

	it.each([
		{ stored: "slirp4netns", version: "podman version 4.3.1", drift: [] },
		{ stored: "slirp4netns", version: "podman version 5.4.2", drift: [{ kind: "network-stack" }] },
		{ stored: "slirp4netns", version: "podman version 6.1.0", drift: [{ kind: "network-stack" }] },
		{ stored: "pasta", version: "podman version 5.4.2", drift: [] },
		{ stored: "pasta", version: "podman version 4.9.3", drift: [{ kind: "network-stack" }] },
	] as const)(
		"reports a stored $stored stack under $version as runtime drift only when they disagree",
		async ({ stored, version, drift }) => {
			const runtime = { ...UNIT_RUNTIME, networkStack: stored }
			const expected = expectedUnits([instance()], [], renderScheduleUnits, runtime)
			const reader = await connected({
				...hostReplies(expected),
				...factsReply({ units: [...expected.keys()], version }),
				[IS_ACTIVE]: reply("active"),
			})

			const { reconciliation } = await reconcileHostOverTransport(
				reader,
				"host-1",
				runtime,
				[instance()],
				expected,
			)

			if (!reconciliation.reachable) throw new Error("expected a reachable host")
			expect(reconciliation.runtimeDrift).toEqual(drift)
			expect(reconciliation.unitDrift).toEqual([])
		},
	)

	it.each([
		{ named: "another port", stdout: "OPEN_MCC_PORT=31337\n", actual: WITHHELD_VALUE },
		{
			named: "the port without its newline",
			stdout: "OPEN_MCC_PORT=33333",
			actual: WITHHELD_VALUE,
		},
		{
			named: "a second line",
			stdout: "OPEN_MCC_PORT=33333\nOPEN_MCC_ARGS=31337\n",
			actual: WITHHELD_VALUE,
		},
		{ named: "no file", stdout: "__open_mcc_missing__", actual: null },
	])(
		"reports a unit.env holding $named as managed drift, never echoing its bytes",
		async ({ stdout, actual }) => {
			const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
			const reader = await connected({
				...hostReplies(expected),
				[UNIT_ENV]: reply(stdout),
				[IS_ACTIVE]: reply("active"),
			})

			const { reconciliation } = await reconcileHostOverTransport(
				reader,
				"host-1",
				UNIT_RUNTIME,
				[instance()],
				expected,
			)

			if (!reconciliation.reachable) throw new Error("expected a reachable host")
			expect(reconciliation.configDrift).toEqual([
				{ instanceId: "abc123", kind: "managed", key: "unit.env", expected: "33333", actual },
			])
			expect(JSON.stringify(reconciliation)).not.toContain("31337")
		},
	)
})

describe("refusing host output it cannot read in full", () => {
	const VALID = factsOutput({ ...HEALTHY, containers: ["open-mcc-abc123"] })

	const swapped = VALID.replace(
		"open-mcc/podman\npodman version 4.3.1\nopen-mcc/containers\nopen-mcc-abc123\n",
		"open-mcc/containers\nopen-mcc-abc123\nopen-mcc/podman\npodman version 4.3.1\n",
	)

	const run = async (stdout: string, exitCode = 0) => {
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const reader = await connected({
			...hostReplies(expected),
			[FACTS]: reply(stdout, exitCode),
			[IS_ACTIVE]: reply("active"),
		})
		return await reconcileHostOverTransport(reader, "host-1", UNIT_RUNTIME, [instance()], expected)
	}

	it("reads the well-formed base every refusal below is cut from", async () => {
		expect(swapped).not.toBe(VALID)
		await expect(run(VALID)).resolves.toMatchObject({ reconciliation: { reachable: true } })
	})

	it.each([
		{ named: "nothing at all", stdout: "" },
		{ named: "output cut off before its end", stdout: VALID.replace("open-mcc/end\n", "") },
		{ named: "a last line with no newline", stdout: VALID.slice(0, -1) },
		{ named: "no image section", stdout: VALID.replace("open-mcc/image\n0\n", "") },
		{
			named: "no status for the image",
			stdout: VALID.replace("open-mcc/image\n0\n", "open-mcc/image\n"),
		},
		{
			named: "an image status other than 0 or 1",
			stdout: VALID.replace("open-mcc/image\n0\n", "open-mcc/image\n125\n"),
		},
		{ named: "no version", stdout: VALID.replace("podman version 4.3.1\n", "") },
		{
			named: "a version Podman does not print",
			stdout: VALID.replace("podman version 4.3.1", "podman version 4.3"),
		},
		{
			named: "two versions",
			stdout: VALID.replace(
				"podman version 4.3.1\n",
				"podman version 4.3.1\npodman version 5.4.2\n",
			),
		},
		{
			named: "a container name Podman would not allow",
			stdout: VALID.replace("open-mcc-abc123", "open-mcc abc123"),
		},
		{ named: "sections out of order", stdout: swapped },
		{ named: "its end twice", stdout: `${VALID}open-mcc/end\n` },
		{ named: "lines after its end", stdout: `${VALID}open-mcc-extra\n` },
	])("refuses $named", async ({ stdout }) => {
		await expect(run(stdout)).rejects.toThrow()
	})

	it("refuses a full answer from a command that failed", async () => {
		await expect(run(VALID, 1)).rejects.toThrow()
	})
})

describe("a live control endpoint that is on but silent", () => {
	const answer: { status: number | "hang up" } = { status: 401 }
	let server: Server
	let serverPort = 0

	beforeAll(async () => {
		server = createServer((request, response) => {
			request.resume()
			request.on("end", () => {
				if (answer.status === "hang up") {
					request.socket.destroy()
					return
				}
				response.writeHead(answer.status).end("31337-body")
			})
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const address = server.address()
		serverPort = address !== null && typeof address === "object" ? address.port : 0
	})

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()))
	})

	const document = renderInstanceConfig({
		accountType: "offline",
		minecraftAccount: "Steve",
		serverAddress: "play.example.net",
		autoRelogRetries: 3,
		autoRelogEnabled: true,
		autoRelogDelaySeconds: { min: 10, max: 10 },
		antiAfkEnabled: false,
		antiAfkIntervalSeconds: { min: 60, max: 60 },
		autoRespawnEnabled: false,
		liveControlEnabled: true,
		liveControlPort: 33333,
		worldDataEnabled: false,
		inventoryDataEnabled: false,
		entityDataEnabled: false,
		advancedKeys: {},
		botConfig: {},
	})

	const probed = async (status: number | "hang up") => {
		answer.status = status
		const expected = expectedUnits([instance()], [], renderScheduleUnits, UNIT_RUNTIME)
		const { transport, reader } = await opened({
			...hostReplies(expected),
			[IS_ACTIVE]: reply("active"),
			[JOURNAL]: reply("[MCC] Server was successfully joined."),
			[CONFIG]: reply(document),
		})
		transport.forwardUntil = async () => {
			const socket = connect(serverPort, "127.0.0.1")
			return { socket, close: () => socket.destroy() }
		}
		const { reconciliation } = await reconcileHostOverTransport(
			reader,
			"host-1",
			UNIT_RUNTIME,
			[instance()],
			expected,
			new Map([["abc123", document]]),
		)
		if (!reconciliation.reachable) throw new Error("expected a reachable host")
		return reconciliation
	}

	it("takes a 401 as proof the client listens", async () => {
		expect((await probed(401)).configDrift).toEqual([])
	})

	it.each([
		{ status: 200 },
		{ status: 403 },
		{ status: 404 },
		{ status: 500 },
		{ status: "hang up" },
	] as const)(
		"calls an answer of $status unreachable, without carrying the answer along",
		async ({ status }) => {
			const reconciliation = await probed(status)

			expect(reconciliation.configDrift).toEqual([
				{
					instanceId: "abc123",
					kind: "unreachable",
					key: "ChatBot.McpServer",
					expected: "33333",
					actual: null,
				},
			])
			expect(JSON.stringify(reconciliation)).not.toContain("31337")
		},
	)
})

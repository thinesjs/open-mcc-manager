import type { InstanceRow, InstanceScheduleRow } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { systemProfile } from "../host/profile"
import { renderUnitTemplates } from "../host/unit-template"
import {
	desiredStateIsSatisfied,
	expectedUnits,
	isManagedUnit,
	looksStuck,
	parseObservedState,
	playerNameFrom,
	reconcileHostOverTransport,
	renderScheduleUnits,
} from "./reconcile"

const PROFILE = systemProfile()

const instance = (overrides: Partial<InstanceRow> = {}): InstanceRow => ({
	id: "abc123",
	organizationId: "org-1",
	hostId: "host-1",
	name: "afk-1",
	minecraftAccount: "afk@example.com",
	minecraftUsername: null,
	status: "running",
	lastExitCode: null,
	authClaimId: null,
	authClaimedAt: null,
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

const connected = async (
	script: Record<string, { stdout: string; stderr: string; exitCode: number }>,
) => {
	const transport = createFakeTransport(script)
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

const listingOf = (names: string[]) => ({
	"ls -1 '/etc/systemd/system'": { stdout: names.join("\n"), stderr: "", exitCode: 0 },
})

const fileReplies = (units: Map<string, string>) =>
	Object.fromEntries(
		[...units].map(([name, contents]) => [
			`cat '/etc/systemd/system/${name}' 2>/dev/null || printf '%s' '__open_mcc_missing__'`,
			{ stdout: contents, stderr: "", exitCode: 0 },
		]),
	)

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
		const expected = expectedUnits(PROFILE, [instance()], [], renderScheduleUnits)
		for (const name of Object.keys(renderUnitTemplates(PROFILE)))
			expect(expected.has(name)).toBe(true)
	})

	it("expects a schedule's timers only for an instance that still exists", () => {
		const orphan = schedule({ instanceId: "gone" })
		const expected = expectedUnits(PROFILE, [instance()], [orphan], renderScheduleUnits)
		expect([...expected.keys()].some((name) => name.includes("gone"))).toBe(false)
	})

	it("expects both timers for a scheduled instance", () => {
		const expected = expectedUnits(PROFILE, [instance()], [schedule()], renderScheduleUnits)
		expect(expected.has("open-mcc-sleep-stop@abc123.timer")).toBe(true)
		expect(expected.has("open-mcc-sleep-start@abc123.timer")).toBe(true)
	})
})

describe("reconciling a host", () => {
	it("reports no drift when every unit matches and the state agrees", async () => {
		const expected = expectedUnits(PROFILE, [instance()], [], renderScheduleUnits)
		const transport = await connected({
			...fileReplies(expected),
			"systemctl is-active 'open-mcc@abc123.service' || true": {
				stdout: "active",
				stderr: "",
				exitCode: 0,
			},
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			PROFILE,
			"host-1",
			[instance()],
			expected,
		)

		expect(result).toEqual({ hostId: "host-1", reachable: true, unitDrift: [], stateDrift: [] })
	})

	it("distinguishes a unit that is absent from one whose content has changed", async () => {
		const expected = expectedUnits(PROFILE, [instance()], [], renderScheduleUnits)
		const replies = fileReplies(expected)
		const names = [...expected.keys()]
		const missing = names[0] ?? ""
		const changed = names[1] ?? ""
		replies[
			`cat '/etc/systemd/system/${missing}' 2>/dev/null || printf '%s' '__open_mcc_missing__'`
		] = { stdout: "__open_mcc_missing__", stderr: "", exitCode: 0 }
		replies[
			`cat '/etc/systemd/system/${changed}' 2>/dev/null || printf '%s' '__open_mcc_missing__'`
		] = { stdout: "edited by hand", stderr: "", exitCode: 0 }

		const transport = await connected({
			...replies,
			"systemctl is-active 'open-mcc@abc123.service' || true": {
				stdout: "active",
				stderr: "",
				exitCode: 0,
			},
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			PROFILE,
			"host-1",
			[instance()],
			expected,
		)
		if (!result.reachable) throw new Error("expected a reachable host")

		expect(result.unitDrift).toContainEqual({ kind: "missing", unit: missing })
		expect(result.unitDrift).toContainEqual({ kind: "differs", unit: changed })
	})

	it("reports an instance the manager believes is running but the host has stopped", async () => {
		const expected = expectedUnits(PROFILE, [instance()], [], renderScheduleUnits)
		const transport = await connected({
			...fileReplies(expected),
			"systemctl is-active 'open-mcc@abc123.service' || true": {
				stdout: "inactive",
				stderr: "",
				exitCode: 3,
			},
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			PROFILE,
			"host-1",
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
	const listing = (names: string[]) => ({
		"ls -1 '/etc/systemd/system'": {
			stdout: names.join("\n"),
			stderr: "",
			exitCode: 0,
		},
	})

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
		const expected = expectedUnits(PROFILE, [instance()], [], renderScheduleUnits)
		const transport = await connected({
			...fileReplies(expected),
			...listing([...expected.keys(), "open-mcc-sleep-stop@deleted1.timer"]),
			"systemctl is-active 'open-mcc@abc123.service' || true": {
				stdout: "active",
				stderr: "",
				exitCode: 0,
			},
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			PROFILE,
			"host-1",
			[instance()],
			expected,
		)
		if (!result.reachable) throw new Error("expected a reachable host")

		expect(result.unitDrift).toEqual([
			{ kind: "unexpected", unit: "open-mcc-sleep-stop@deleted1.timer" },
		])
	})

	it("leaves unrelated units on the host alone, which are none of its business", async () => {
		const expected = expectedUnits(PROFILE, [instance()], [], renderScheduleUnits)
		const transport = await connected({
			...fileReplies(expected),
			...listing([...expected.keys(), "nginx.service", "ssh.service", "cron.service"]),
			"systemctl is-active 'open-mcc@abc123.service' || true": {
				stdout: "active",
				stderr: "",
				exitCode: 0,
			},
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			PROFILE,
			"host-1",
			[instance()],
			expected,
		)
		if (!result.reachable) throw new Error("expected a reachable host")

		expect(result.unitDrift).toEqual([])
	})

	it("reports another organization's timer on a shared host, which the trust model allows", async () => {
		const expected = expectedUnits(PROFILE, [instance()], [], renderScheduleUnits)
		const transport = await connected({
			...fileReplies(expected),
			...listing([...expected.keys(), "open-mcc-sleep-stop@otherorg1.timer"]),
			"systemctl is-active 'open-mcc@abc123.service' || true": {
				stdout: "active",
				stderr: "",
				exitCode: 0,
			},
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			PROFILE,
			"host-1",
			[instance()],
			expected,
		)
		if (!result.reachable) throw new Error("expected a reachable host")

		expect(result.unitDrift).toEqual([
			{ kind: "unexpected", unit: "open-mcc-sleep-stop@otherorg1.timer" },
		])
	})

	it("treats a failed listing as unknown rather than as a host with nothing extra", async () => {
		const expected = expectedUnits(PROFILE, [instance()], [], renderScheduleUnits)
		const transport = await connected({
			...fileReplies(expected),
			"ls -1 '/etc/systemd/system'": { stdout: "", stderr: "Permission denied", exitCode: 2 },
		})

		await expect(
			reconcileHostOverTransport(transport, PROFILE, "host-1", [instance()], expected),
		).rejects.toThrow(/Permission denied/)
	})
})

describe("a client that is running but not doing anything", () => {
	const journalFor = (text: string) => ({
		"journalctl -u 'open-mcc@abc123.service' --lines 20 --no-pager --output cat 2>/dev/null || true":
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
		const expected = expectedUnits(PROFILE, [instance()], [], renderScheduleUnits)
		const transport = await connected({
			...fileReplies(expected),
			...listingOf([...expected.keys()]),
			"systemctl is-active 'open-mcc@abc123.service' || true": {
				stdout: "active",
				stderr: "",
				exitCode: 0,
			},
			...journalFor('Failed to parse the settings file, enter "/new" to generate'),
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			PROFILE,
			"host-1",
			[instance()],
			expected,
		)
		if (!result.reachable) throw new Error("expected a reachable host")

		expect(result.stateDrift).toEqual([
			{ instanceId: "abc123", desired: "running", observed: "stuck" },
		])
	})

	it("leaves a genuinely healthy instance alone", async () => {
		const expected = expectedUnits(PROFILE, [instance()], [], renderScheduleUnits)
		const transport = await connected({
			...fileReplies(expected),
			...listingOf([...expected.keys()]),
			"systemctl is-active 'open-mcc@abc123.service' || true": {
				stdout: "active",
				stderr: "",
				exitCode: 0,
			},
			...journalFor("[MCC] Server was successfully joined."),
		})

		const { reconciliation: result } = await reconcileHostOverTransport(
			transport,
			PROFILE,
			"host-1",
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

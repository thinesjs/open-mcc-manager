import type {
	ConfigDriftPublic,
	HostReconciliation,
	ObservedState,
	StateDrift,
	UnitDrift,
} from "@open-mcc/contracts"
import { readMccConfigKeys } from "@open-mcc/contracts/boundary/mcc-config"
import type { InstanceRow, InstanceScheduleRow } from "@open-mcc/db"
import type { HostTransport } from "@open-mcc/transport"
import { type HostProfile, journalctl, systemctl } from "../host/profile"
import { renderUnitTemplates } from "../host/unit-template"
import type { ConfigDrift } from "./config-drift"
import { CONFIG_PATH_NAME, compareInstanceConfig, formatConfigValue } from "./config-drift"
import { parseDaysOfWeek as parseStoredDays, renderSleepTimers } from "./schedule"
import { instanceDir, unitName } from "./unit"

export type { ConfigDriftPublic, HostReconciliation, ObservedState, StateDrift, UnitDrift }

export const RECONCILE_STEP_TIMEOUT_MS = 15_000

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

const OBSERVED_STATES: readonly ObservedState[] = [
	"active",
	"inactive",
	"failed",
	"activating",
] as const

export const STUCK_MARKERS = [
	"Failed to parse the settings file",
	"Not connected to any server",
	"press Enter to exit Minecraft Console Client",
] as const

export const SERVER_INFO_MARKER = "Server version:"

export const JOINED_MARKER = "Server was successfully joined"

export const STUCK_SCAN_LINES = 20

export const PLAYER_NAME_PATTERN = /Cached session is still valid for ([A-Za-z0-9_]{3,16})\./

export const playerNameFrom = (journal: string): string | undefined =>
	PLAYER_NAME_PATTERN.exec(journal)?.[1]

export const CHAT_MARKER = "\u258c"

export const clientEmittedLines = (journal: string): string =>
	journal
		.split("\n")
		.filter((line) => !line.includes(CHAT_MARKER))
		.join("\n")

export const looksStuck = (journal: string): boolean => {
	const own = clientEmittedLines(journal)
	if (STUCK_MARKERS.some((marker) => own.includes(marker))) return true
	return own.includes(SERVER_INFO_MARKER) && !own.includes(JOINED_MARKER)
}

export const parseObservedState = (output: string): ObservedState => {
	const value = output.trim()
	const known = OBSERVED_STATES.find((state) => state === value)
	return known ?? "unknown"
}

export const desiredStateIsSatisfied = (
	desired: InstanceRow["status"],
	observed: ObservedState,
): boolean => {
	if (desired === "running") return observed === "active" || observed === "activating"
	if (observed === "stuck") return false
	if (desired === "stopped") return observed === "inactive"
	return true
}

const MISSING_MARKER = "__open_mcc_missing__"

const readFile = async (transport: HostTransport, path: string): Promise<string | undefined> => {
	const result = await transport.exec(
		`cat ${shellQuote(path)} 2>/dev/null || printf '%s' ${shellQuote(MISSING_MARKER)}`,
		RECONCILE_STEP_TIMEOUT_MS,
	)
	return result.stdout === MISSING_MARKER ? undefined : result.stdout
}

export const expectedUnits = (
	profile: HostProfile,
	instances: readonly InstanceRow[],
	schedules: readonly InstanceScheduleRow[],
	renderWindow: (schedule: InstanceScheduleRow) => Record<string, string>,
): Map<string, string> => {
	const expected = new Map<string, string>()
	for (const [name, contents] of Object.entries(renderUnitTemplates(profile))) {
		expected.set(name, contents)
	}
	const known = new Set(instances.map((instance) => instance.id))
	for (const schedule of schedules) {
		if (!known.has(schedule.instanceId)) continue
		for (const [name, contents] of Object.entries(renderWindow(schedule))) {
			expected.set(name, contents)
		}
	}
	return expected
}

export const MANAGED_UNIT_PATTERN =
	/^open-mcc(?:-sleep-(?:stop|start)|-auth)?@[A-Za-z0-9_-]{0,64}\.(?:service|timer)$/

export const isManagedUnit = (name: string): boolean => MANAGED_UNIT_PATTERN.test(name)

const listManagedUnits = async (
	transport: HostTransport,
	profile: HostProfile,
): Promise<string[]> => {
	const result = await transport.exec(
		`ls -1 ${shellQuote(profile.unitDir)}`,
		RECONCILE_STEP_TIMEOUT_MS,
	)
	if (result.exitCode !== 0) {
		throw new Error(`Could not list ${profile.unitDir}: ${result.stderr.trim()}`)
	}
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && isManagedUnit(line))
}

export type HostObservation = {
	reconciliation: HostReconciliation
	seenPlayers: ReadonlyMap<string, string>
}

const readInstanceConfig = async (
	transport: HostTransport,
	profile: HostProfile,
	instanceId: string,
): Promise<string | undefined> => {
	const path = `${instanceDir(profile.instancesRoot, instanceId)}/${CONFIG_PATH_NAME}`
	const result = await transport.exec(
		`cat ${shellQuote(path)} 2>/dev/null || true`,
		RECONCILE_STEP_TIMEOUT_MS,
	)
	const text = result.stdout
	return text.trim().length === 0 ? undefined : text
}

const toPublicDrift = (instanceId: string, entry: ConfigDrift): ConfigDriftPublic => {
	if (entry.kind === "section") {
		return {
			instanceId,
			kind: "section",
			key: entry.section,
			expected: "empty",
			actual: String(entry.entries),
		}
	}
	if (entry.kind === "unreadable") {
		return { instanceId, kind: "unreadable", key: entry.key, expected: null, actual: null }
	}
	if (entry.kind === "operator") {
		return {
			instanceId,
			kind: "operator",
			key: entry.key,
			expected: formatConfigValue(entry.expected),
			actual: null,
		}
	}
	return {
		instanceId,
		kind: entry.kind,
		key: entry.key,
		expected: formatConfigValue(entry.expected),
		actual: entry.actual === undefined ? null : formatConfigValue(entry.actual),
	}
}

const configDriftFor = async (
	transport: HostTransport,
	profile: HostProfile,
	instances: readonly InstanceRow[],
	expectedConfigs: ReadonlyMap<string, string>,
): Promise<ConfigDriftPublic[]> => {
	const drift: ConfigDriftPublic[] = []
	for (const instance of instances) {
		const want = expectedConfigs.get(instance.id)
		if (want === undefined) continue
		const actual = await readInstanceConfig(transport, profile, instance.id)
		if (actual === undefined) {
			drift.push({
				instanceId: instance.id,
				kind: "managed",
				key: CONFIG_PATH_NAME,
				expected: "a config file",
				actual: null,
			})
			continue
		}
		let found: ReturnType<typeof compareInstanceConfig>
		try {
			found = compareInstanceConfig(want, actual)
		} catch {
			drift.push({
				instanceId: instance.id,
				kind: "unreadable",
				key: CONFIG_PATH_NAME,
				expected: null,
				actual: null,
			})
			continue
		}
		for (const entry of found) {
			drift.push(toPublicDrift(instance.id, entry))
		}
	}
	return drift
}

const silentLiveControl = async (
	transport: HostTransport,
	instances: readonly InstanceRow[],
	expectedConfigs: ReadonlyMap<string, string>,
	joined: ReadonlySet<string>,
): Promise<ConfigDriftPublic[]> => {
	const drift: ConfigDriftPublic[] = []
	for (const instance of instances) {
		if (!joined.has(instance.id)) continue
		const document = expectedConfigs.get(instance.id)
		if (document === undefined) continue
		const reading = readMccConfigKeys(document, [
			"ChatBot.McpServer.Enabled",
			"ChatBot.McpServer.Transport.Port",
		])
		if (reading.values.get("ChatBot.McpServer.Enabled") !== true) continue
		const port = reading.values.get("ChatBot.McpServer.Transport.Port")
		if (typeof port !== "number") continue
		if (await transport.canForward(port, RECONCILE_STEP_TIMEOUT_MS)) continue
		drift.push({
			instanceId: instance.id,
			kind: "unreachable",
			key: "ChatBot.McpServer",
			expected: String(port),
			actual: null,
		})
	}
	return drift
}

export const reconcileHostOverTransport = async (
	transport: HostTransport,
	profile: HostProfile,
	hostId: string,
	instances: readonly InstanceRow[],
	expected: Map<string, string>,
	expectedConfigs: ReadonlyMap<string, string> = new Map(),
): Promise<HostObservation> => {
	const unitDrift: UnitDrift[] = []
	for (const [name, contents] of expected) {
		const actual = await readFile(transport, `${profile.unitDir}/${name}`)
		if (actual === undefined) unitDrift.push({ kind: "missing", unit: name })
		else if (actual !== contents) unitDrift.push({ kind: "differs", unit: name })
	}

	for (const name of await listManagedUnits(transport, profile)) {
		if (!expected.has(name)) unitDrift.push({ kind: "unexpected", unit: name })
	}

	const stateDrift: StateDrift[] = []
	const joined = new Set<string>()
	const seenPlayers = new Map<string, string>()
	for (const instance of instances) {
		const result = await transport.exec(
			`${systemctl(profile, `is-active ${shellQuote(`${unitName(instance.id)}.service`)}`)} || true`,
			RECONCILE_STEP_TIMEOUT_MS,
		)
		let observed = parseObservedState(result.stdout)
		if (observed === "active" && instance.status === "running") {
			const journal = await transport.exec(
				`${journalctl(profile, `-u ${shellQuote(`${unitName(instance.id)}.service`)} --lines ${STUCK_SCAN_LINES} --no-pager --output cat`)} 2>/dev/null || true`,
				RECONCILE_STEP_TIMEOUT_MS,
			)
			if (looksStuck(journal.stdout)) observed = "stuck"
			if (journal.stdout.includes(JOINED_MARKER)) joined.add(instance.id)
			const player = playerNameFrom(journal.stdout)
			if (player) seenPlayers.set(instance.id, player)
		}
		if (!desiredStateIsSatisfied(instance.status, observed)) {
			stateDrift.push({ instanceId: instance.id, desired: instance.status, observed })
		}
	}

	const configDrift = await configDriftFor(transport, profile, instances, expectedConfigs)
	configDrift.push(...(await silentLiveControl(transport, instances, expectedConfigs, joined)))

	return {
		reconciliation: { hostId, reachable: true, unitDrift, stateDrift, configDrift },
		seenPlayers,
	}
}

export const renderScheduleUnits = (schedule: InstanceScheduleRow): Record<string, string> =>
	renderSleepTimers({
		id: schedule.id,
		instanceId: schedule.instanceId,
		daysOfWeek: parseStoredDays(schedule.daysOfWeek),
		stopAt: minutesToTime(schedule.stopMinuteOfDay),
		startAt: minutesToTime(schedule.startMinuteOfDay),
		timezone: schedule.timezone,
		enabled: schedule.enabled,
	})

const minutesToTime = (minutes: number) => ({
	hour: Math.floor(minutes / 60),
	minute: minutes % 60,
})

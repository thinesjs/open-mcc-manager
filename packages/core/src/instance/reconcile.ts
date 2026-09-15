import type {
	ConfigDriftPublic,
	HostReconciliation,
	HostUnreachableReason,
	ObservedState,
	RuntimeDrift,
	StateDrift,
	UnitDrift,
} from "@open-mcc/contracts"
import { readMccConfigKeys } from "@open-mcc/contracts/boundary/mcc-config"
import type { InstanceRow, InstanceScheduleRow } from "@open-mcc/db"
import { asReadCommand, type HostReader } from "@open-mcc/transport"
import { parsePodmanVersion, requiredStackFor } from "../host/podman-facts"
import { journalctl, podman, systemctl, UNIT_DIR } from "../host/profile"
import type { RuntimeHost } from "../host/runtime-guard"
import { podmanImageId, RUNTIME_IMAGE_REPOSITORY, runtimeImageFor } from "../host/runtime-image"
import { renderUnitTemplates, type UnitRuntime } from "../host/unit-template"
import { LIVE_CONTROL_ROUTE } from "./config"
import type { ConfigDrift } from "./config-drift"
import {
	CONFIG_PATH_NAME,
	compareInstanceConfig,
	formatConfigValue,
	isOperatorKey,
	isSecretKey,
} from "./config-drift"
import { probeListening } from "./live-control"
import { parseDaysOfWeek as parseStoredDays, renderSleepTimers } from "./schedule"
import { CONFIG_FILE_PATH, INSTANCE_LAYOUT, instanceDir, renderUnitEnv, unitName } from "./unit"

export type {
	ConfigDriftPublic,
	HostReconciliation,
	HostUnreachableReason,
	ObservedState,
	RuntimeDrift,
	StateDrift,
	UnitDrift,
}

export const RECONCILE_DEADLINE_MS = 60_000

type SetupReader = Pick<HostReader, "exec" | "forward">

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

const readFile = async (reader: SetupReader, path: string): Promise<string | undefined> => {
	const result = await reader.exec(
		asReadCommand(`cat ${path} 2>/dev/null || printf '%s' ${shellQuote(MISSING_MARKER)}`),
	)
	return result.stdout === MISSING_MARKER ? undefined : result.stdout
}

export const unitRuntimeFor = (
	host: Pick<RuntimeHost, "networkStack" | "architecture">,
): UnitRuntime => ({
	networkStack: host.networkStack,
	imageId: podmanImageId(runtimeImageFor(host.architecture)),
})

export const expectedUnits = (
	instances: readonly InstanceRow[],
	schedules: readonly InstanceScheduleRow[],
	renderWindow: (schedule: InstanceScheduleRow) => Record<string, string>,
	runtime: UnitRuntime,
): Map<string, string> => {
	const expected = new Map<string, string>()
	for (const [name, contents] of Object.entries(renderUnitTemplates(runtime))) {
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

const FACT_SECTIONS = {
	units: "open-mcc/units",
	podman: "open-mcc/podman",
	containers: "open-mcc/containers",
	image: "open-mcc/image",
	end: "open-mcc/end",
} as const

const section = (marker: string): string => `printf '%s\\n' ${marker}`

export const reconcileFactsCommand = (imageId: string): string =>
	[
		section(FACT_SECTIONS.units),
		`ls -1 ${UNIT_DIR}`,
		section(FACT_SECTIONS.podman),
		"podman --version",
		section(FACT_SECTIONS.containers),
		podman("ps -a --format '{{.Names}}'"),
		section(FACT_SECTIONS.image),
		`{ ${podman(`image exists ${shellQuote(imageId)}`)}; printf '%s\\n' "$?"; }`,
		section(FACT_SECTIONS.end),
	].join(" && ")

const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

const linesBetween = (lines: readonly string[], from: string, to: string): string[] | undefined => {
	const start = lines.indexOf(from)
	const stop = lines.indexOf(to)
	if (start < 0 || stop <= start) return undefined
	if (lines.lastIndexOf(from) !== start || lines.lastIndexOf(to) !== stop) return undefined
	return lines.slice(start + 1, stop)
}

const parseReconcileFacts = (output: string) => {
	if (!output.endsWith("\n")) return undefined
	const lines = output.slice(0, -1).split("\n")
	if (lines.at(0) !== FACT_SECTIONS.units || lines.at(-1) !== FACT_SECTIONS.end) return undefined
	const units = linesBetween(lines, FACT_SECTIONS.units, FACT_SECTIONS.podman)
	const versions = linesBetween(lines, FACT_SECTIONS.podman, FACT_SECTIONS.containers)
	const containers = linesBetween(lines, FACT_SECTIONS.containers, FACT_SECTIONS.image)
	const statuses = linesBetween(lines, FACT_SECTIONS.image, FACT_SECTIONS.end)
	if (
		units === undefined ||
		versions === undefined ||
		containers === undefined ||
		statuses === undefined
	) {
		return undefined
	}
	const version = versions.length === 1 ? parsePodmanVersion(versions.join("")) : null
	const status = statuses.length === 1 ? statuses.join("") : undefined
	if (version === null || (status !== "0" && status !== "1")) return undefined
	if (!containers.every((name) => CONTAINER_NAME.test(name))) return undefined
	return {
		units: units.map((line) => line.trim()).filter((line) => isManagedUnit(line)),
		podman: version,
		containers,
		imageExists: status === "0",
	}
}

const readHostFacts = async (reader: SetupReader, imageId: string) => {
	const result = await reader.exec(asReadCommand(reconcileFactsCommand(imageId)))
	if (result.exitCode !== 0) {
		throw new Error(`Could not read the host's units and containers: ${result.stderr.trim()}`)
	}
	const facts = parseReconcileFacts(result.stdout)
	if (facts === undefined) {
		throw new Error("The host's units and containers could not be read in full")
	}
	return facts
}

const CONTAINER_PREFIX = "open-mcc-"

const MANAGED_CONTAINER_PATTERN = /^open-mcc-(?:auth-)?([A-Za-z0-9_-]{1,64})$/

const leftoverContainers = (
	names: readonly string[],
	instances: readonly InstanceRow[],
): string[] => {
	const known = new Set(instances.map((instance) => instance.id))
	return names.filter((name) => {
		const match = MANAGED_CONTAINER_PATTERN.exec(name)
		if (match === null) return false
		const [, id = ""] = match
		return !known.has(id) && !known.has(name.slice(CONTAINER_PREFIX.length))
	})
}

export type HostObservation = {
	reconciliation: HostReconciliation
	seenPlayers: ReadonlyMap<string, string>
}

const readInstanceConfig = async (
	reader: SetupReader,
	instanceId: string,
): Promise<string | undefined> => {
	const path = `${instanceDir(instanceId)}/${CONFIG_FILE_PATH}`
	const result = await reader.exec(asReadCommand(`cat ${path} 2>/dev/null || true`))
	const text = result.stdout
	return text.trim().length === 0 ? undefined : text
}

export const WITHHELD_VALUE = "something else"

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
	if (isSecretKey(entry.key) || isOperatorKey(entry.key)) {
		return {
			instanceId,
			kind: entry.kind,
			key: entry.key,
			expected: formatConfigValue(entry.expected),
			actual: entry.actual === undefined ? null : WITHHELD_VALUE,
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
	reader: SetupReader,
	instances: readonly InstanceRow[],
	expectedConfigs: ReadonlyMap<string, string>,
): Promise<ConfigDriftPublic[]> => {
	const drift: ConfigDriftPublic[] = []
	for (const instance of instances) {
		const want = expectedConfigs.get(instance.id)
		if (want === undefined) continue
		const actual = await readInstanceConfig(reader, instance.id)
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

const unitEnvDriftFor = async (
	reader: SetupReader,
	instances: readonly InstanceRow[],
): Promise<ConfigDriftPublic[]> => {
	const drift: ConfigDriftPublic[] = []
	for (const instance of instances) {
		const actual = await readFile(reader, `${instanceDir(instance.id)}/${INSTANCE_LAYOUT.unitEnv}`)
		if (actual === renderUnitEnv(instance.liveControlPort)) continue
		drift.push({
			instanceId: instance.id,
			kind: "managed",
			key: INSTANCE_LAYOUT.unitEnv,
			expected: String(instance.liveControlPort),
			actual: actual === undefined ? null : WITHHELD_VALUE,
		})
	}
	return drift
}

const silentLiveControl = async (
	reader: SetupReader,
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
		if (await probeListening({ reader, port, route: LIVE_CONTROL_ROUTE })) continue
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
	reader: SetupReader,
	hostId: string,
	runtime: UnitRuntime,
	instances: readonly InstanceRow[],
	expected: Map<string, string>,
	expectedConfigs: ReadonlyMap<string, string> = new Map(),
): Promise<HostObservation> => {
	const facts = await readHostFacts(reader, runtime.imageId)
	const runtimeDrift: RuntimeDrift[] =
		requiredStackFor(facts.podman.major) === runtime.networkStack ? [] : [{ kind: "network-stack" }]

	const unitDrift: UnitDrift[] = []
	for (const [name, contents] of expected) {
		const actual = await readFile(reader, `${UNIT_DIR}/${shellQuote(name)}`)
		if (actual === undefined) unitDrift.push({ kind: "missing", unit: name })
		else if (actual !== contents) unitDrift.push({ kind: "differs", unit: name })
	}

	for (const name of facts.units) {
		if (!expected.has(name)) unitDrift.push({ kind: "unexpected", unit: name })
	}
	for (const name of leftoverContainers(facts.containers, instances)) {
		unitDrift.push({ kind: "unexpected", unit: name })
	}
	if (!facts.imageExists) unitDrift.push({ kind: "missing", unit: RUNTIME_IMAGE_REPOSITORY })

	const stateDrift: StateDrift[] = []
	const joined = new Set<string>()
	const seenPlayers = new Map<string, string>()
	for (const instance of instances) {
		const result = await reader.exec(
			asReadCommand(
				`${systemctl(`is-active ${shellQuote(`${unitName(instance.id)}.service`)}`)} || true`,
			),
		)
		let observed = parseObservedState(result.stdout)
		if (observed === "active" && instance.status === "running") {
			const journal = await reader.exec(
				asReadCommand(
					`${journalctl(`-u ${shellQuote(`${unitName(instance.id)}.service`)} --lines ${STUCK_SCAN_LINES} --no-pager --output cat`)} 2>/dev/null || true`,
				),
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

	const configDrift = await configDriftFor(reader, instances, expectedConfigs)
	configDrift.push(...(await unitEnvDriftFor(reader, instances)))
	configDrift.push(...(await silentLiveControl(reader, instances, expectedConfigs, joined)))

	return {
		reconciliation: { hostId, reachable: true, runtimeDrift, unitDrift, stateDrift, configDrift },
		seenPlayers,
	}
}

export const renderScheduleUnits = (schedule: InstanceScheduleRow): Record<string, string> =>
	renderSleepTimers({
		instanceId: schedule.instanceId,
		daysOfWeek: parseStoredDays(schedule.daysOfWeek),
		stopAt: minutesToTime(schedule.stopMinuteOfDay),
		startAt: minutesToTime(schedule.startMinuteOfDay),
		timezone: schedule.timezone,
	})

const minutesToTime = (minutes: number) => ({
	hour: Math.floor(minutes / 60),
	minute: minutes % 60,
})

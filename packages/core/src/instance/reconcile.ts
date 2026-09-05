import type { HostReconciliation, ObservedState, StateDrift, UnitDrift } from "@open-mcc/contracts"
import type { InstanceRow, InstanceScheduleRow } from "@open-mcc/db"
import type { HostTransport } from "@open-mcc/transport"
import { SYSTEMD_UNIT_DIR } from "../host/provision"
import { UNIT_TEMPLATES } from "../host/unit-template"
import { parseDaysOfWeek as parseStoredDays, renderSleepTimers } from "./schedule"
import { unitName } from "./unit"

export type { HostReconciliation, ObservedState, StateDrift, UnitDrift }

export const RECONCILE_STEP_TIMEOUT_MS = 15_000

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

const OBSERVED_STATES: readonly ObservedState[] = [
	"active",
	"inactive",
	"failed",
	"activating",
] as const

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
	instances: readonly InstanceRow[],
	schedules: readonly InstanceScheduleRow[],
	renderWindow: (schedule: InstanceScheduleRow) => Record<string, string>,
): Map<string, string> => {
	const expected = new Map<string, string>()
	for (const [name, contents] of Object.entries(UNIT_TEMPLATES)) {
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
	/^open-mcc(?:-sleep-(?:stop|start))?@[A-Za-z0-9_-]{0,64}\.(?:service|timer)$/

export const isManagedUnit = (name: string): boolean => MANAGED_UNIT_PATTERN.test(name)

const listManagedUnits = async (transport: HostTransport): Promise<string[]> => {
	const result = await transport.exec(
		`ls -1 ${shellQuote(SYSTEMD_UNIT_DIR)}`,
		RECONCILE_STEP_TIMEOUT_MS,
	)
	if (result.exitCode !== 0) {
		throw new Error(`Could not list ${SYSTEMD_UNIT_DIR}: ${result.stderr.trim()}`)
	}
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && isManagedUnit(line))
}

export const reconcileHostOverTransport = async (
	transport: HostTransport,
	hostId: string,
	instances: readonly InstanceRow[],
	expected: Map<string, string>,
): Promise<HostReconciliation> => {
	const unitDrift: UnitDrift[] = []
	for (const [name, contents] of expected) {
		const actual = await readFile(transport, `${SYSTEMD_UNIT_DIR}/${name}`)
		if (actual === undefined) unitDrift.push({ kind: "missing", unit: name })
		else if (actual !== contents) unitDrift.push({ kind: "differs", unit: name })
	}

	for (const name of await listManagedUnits(transport)) {
		if (!expected.has(name)) unitDrift.push({ kind: "unexpected", unit: name })
	}

	const stateDrift: StateDrift[] = []
	for (const instance of instances) {
		const result = await transport.exec(
			`systemctl is-active ${shellQuote(`${unitName(instance.id)}.service`)} || true`,
			RECONCILE_STEP_TIMEOUT_MS,
		)
		const observed = parseObservedState(result.stdout)
		if (!desiredStateIsSatisfied(instance.status, observed)) {
			stateDrift.push({ instanceId: instance.id, desired: instance.status, observed })
		}
	}

	return { hostId, reachable: true, unitDrift, stateDrift }
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

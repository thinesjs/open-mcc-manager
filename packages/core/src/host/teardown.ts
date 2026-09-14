import type { HostTransport } from "@open-mcc/transport"
import { isManagedUnit } from "../instance/reconcile"
import { INSTANCES_PATH, INSTANCES_ROOT, systemctl, UNIT_DIR } from "./profile"

export const TEARDOWN_TIMEOUT_MS = 20_000

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const selfExcludingPattern = (path: string): string => {
	const trimmed = path.replace(/\/+$/, "")
	const cut = trimmed.lastIndexOf("/")
	const head = trimmed.slice(0, cut + 1)
	const tail = trimmed.slice(cut + 1)
	if (tail.length === 0) return trimmed
	return `${head}[${tail.slice(0, 1)}]${tail.slice(1)}`
}

const PROCESS_PATTERN = `"$HOME"/${shellQuote(selfExcludingPattern(INSTANCES_PATH))}`

export type TeardownReport = {
	unitsRemoved: readonly string[]
	directoryRemoved: boolean
	processesLeft: number
	lingeringLeft: boolean
	remaining: readonly string[]
}

const listManagedUnits = async (transport: HostTransport): Promise<string[]> => {
	const result = await transport.exec(`ls -1 ${UNIT_DIR} 2>/dev/null || true`, TEARDOWN_TIMEOUT_MS)
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && isManagedUnit(line))
}

export const tearDownHost = async (transport: HostTransport): Promise<TeardownReport> => {
	const remaining: string[] = []
	const units = await listManagedUnits(transport)

	for (const unit of units) {
		await transport.exec(
			`${systemctl(`disable --now ${shellQuote(unit)}`)} || true`,
			TEARDOWN_TIMEOUT_MS,
		)
	}
	for (const unit of units) {
		await transport.exec(`rm -f ${UNIT_DIR}/${shellQuote(unit)}`, TEARDOWN_TIMEOUT_MS)
	}
	await transport.exec(systemctl("daemon-reload"), TEARDOWN_TIMEOUT_MS)
	await transport.exec(`${systemctl("reset-failed")} || true`, TEARDOWN_TIMEOUT_MS)

	await transport.exec(`pkill -f ${PROCESS_PATTERN} || true`, TEARDOWN_TIMEOUT_MS)

	await transport.exec(`rm -rf ${INSTANCES_ROOT}`, TEARDOWN_TIMEOUT_MS)
	const check = await transport.exec(
		`test -e ${INSTANCES_ROOT} && printf present || printf gone`,
		TEARDOWN_TIMEOUT_MS,
	)
	const directoryRemoved = check.stdout.trim() === "gone"
	if (!directoryRemoved) remaining.push(`~/${INSTANCES_PATH} could not be removed`)

	const leftoverUnits = await listManagedUnits(transport)
	for (const unit of leftoverUnits) remaining.push(`${unit} is still installed`)

	const processes = await transport.exec(
		`pgrep -f ${PROCESS_PATTERN} 2>/dev/null | grep -c . || true`,
		TEARDOWN_TIMEOUT_MS,
	)
	const processesLeft = Number.parseInt(processes.stdout.trim(), 10)
	const stillRunning = Number.isSafeInteger(processesLeft) && processesLeft > 0 ? processesLeft : 0
	if (stillRunning > 0) remaining.push(`${stillRunning} process(es) still running`)

	const lingering = await transport.exec(
		'loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || printf no',
		TEARDOWN_TIMEOUT_MS,
	)

	return {
		unitsRemoved: units,
		directoryRemoved,
		processesLeft: stillRunning,
		lingeringLeft: lingering.stdout.trim() === "yes",
		remaining,
	}
}

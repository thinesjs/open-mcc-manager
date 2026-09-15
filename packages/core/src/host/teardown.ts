import type { HostTransport } from "@open-mcc/transport"
import { isManagedUnit, MANAGED_CONTAINER_PATTERN } from "../instance/reconcile"
import { UNIT_STOP_TIMEOUT_MS } from "../instance/removal"
import { RUNNING_UNIT_STATES } from "../instance/unit"
import { withDeadline } from "./deadline"
import type { MccArchitecture } from "./mcc-release"
import { INSTANCES_PATH, INSTANCES_ROOT, podman, systemctl, UNIT_DIR } from "./profile"
import { podmanImageId, runtimeImageFor } from "./runtime-image"

export const TEARDOWN_TIMEOUT_MS = 20_000

const CONTAINERS_TIMEOUT_MS = 60_000

const IMAGE_TIMEOUT_MS = 15_000

const FILES_TIMEOUT_MS = 60_000

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

const BOT_UNITS = ["open-mcc@*.service", "open-mcc-auth@*.service"].map(shellQuote).join(" ")

export type TeardownReport = {
	unitsRemoved: readonly string[]
	directoryRemoved: boolean
	lingeringLeft: boolean
	remaining: readonly string[]
}

const linesOf = (output: string): string[] =>
	output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)

const listManagedUnits = async (transport: HostTransport): Promise<string[]> => {
	const result = await transport.exec(`ls -1 ${UNIT_DIR} 2>/dev/null || true`, TEARDOWN_TIMEOUT_MS)
	return linesOf(result.stdout).filter((line) => isManagedUnit(line))
}

const listContainers = async (transport: HostTransport): Promise<string[] | undefined> => {
	const result = await transport.exec(podman("ps -a --format '{{.Names}}'"), TEARDOWN_TIMEOUT_MS)
	if (result.exitCode !== 0) return undefined
	return linesOf(result.stdout).filter((name) => MANAGED_CONTAINER_PATTERN.test(name))
}

const countRunningUnits = async (transport: HostTransport): Promise<number | undefined> => {
	const result = await transport.exec(
		systemctl(
			`list-units --plain --no-legend --state=${RUNNING_UNIT_STATES.join(",")} ${shellQuote("open-mcc*")}`,
		),
		TEARDOWN_TIMEOUT_MS,
	)
	if (result.exitCode !== 0) return undefined
	return linesOf(result.stdout).filter((line) => isManagedUnit(line.split(/\s+/)[0] ?? "")).length
}

export const tearDownHost = async (
	transport: HostTransport,
	architecture: MccArchitecture | undefined,
): Promise<TeardownReport> => {
	const remaining: string[] = []
	const units = await listManagedUnits(transport)

	for (const unit of units) {
		await transport.exec(
			`${systemctl(`disable --now ${shellQuote(unit)}`)} || true`,
			TEARDOWN_TIMEOUT_MS,
		)
	}
	await transport.exec(systemctl(`stop ${BOT_UNITS}`), UNIT_STOP_TIMEOUT_MS)

	const containers = await listContainers(transport)
	if (containers !== undefined && containers.length > 0) {
		await transport.exec(
			withDeadline(5, 50, `podman rm -f --ignore ${containers.join(" ")}`),
			CONTAINERS_TIMEOUT_MS,
		)
	}
	const containersLeft = await listContainers(transport)
	if (containersLeft === undefined) remaining.push("The containers could not be listed")
	else if (containersLeft.length > 0) {
		remaining.push(`${containersLeft.length} container(s) still present`)
	}
	const running = await countRunningUnits(transport)
	if (running === undefined) remaining.push("The running units could not be listed")
	else if (running > 0) remaining.push(`${running} unit(s) still running`)

	for (const unit of units) {
		await transport.exec(`rm -f ${UNIT_DIR}/${shellQuote(unit)}`, TEARDOWN_TIMEOUT_MS)
	}
	await transport.exec(systemctl("daemon-reload"), TEARDOWN_TIMEOUT_MS)
	await transport.exec(`${systemctl("reset-failed")} || true`, TEARDOWN_TIMEOUT_MS)

	if (architecture !== undefined) {
		const image = await transport.exec(
			withDeadline(3, 10, `podman rmi --ignore ${podmanImageId(runtimeImageFor(architecture))}`),
			IMAGE_TIMEOUT_MS,
		)
		if (image.exitCode !== 0) remaining.push("The runtime image could not be removed")
	}

	await transport.exec(
		withDeadline(
			5,
			50,
			`sh -c 'chmod -R u+rwX -- ${INSTANCES_ROOT} && rm -rf -- ${INSTANCES_ROOT}'`,
		),
		FILES_TIMEOUT_MS,
	)
	const check = await transport.exec(
		`test -e ${INSTANCES_ROOT} && printf present || printf gone`,
		TEARDOWN_TIMEOUT_MS,
	)
	const directoryRemoved = check.stdout.trim() === "gone"
	if (!directoryRemoved) remaining.push(`~/${INSTANCES_PATH} could not be removed`)

	const leftoverUnits = await listManagedUnits(transport)
	for (const unit of leftoverUnits) remaining.push(`${unit} is still installed`)

	const lingering = await transport.exec(
		'loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || printf no',
		TEARDOWN_TIMEOUT_MS,
	)

	return {
		unitsRemoved: units,
		directoryRemoved,
		lingeringLeft: lingering.stdout.trim() === "yes",
		remaining,
	}
}

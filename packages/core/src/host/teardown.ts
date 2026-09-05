import type { HostTransport } from "@open-mcc/transport"
import { isManagedUnit } from "../instance/reconcile"
import { instanceUser } from "../instance/unit"
import { type HostProfile, systemctl, usesPerInstanceUsers } from "./profile"

export const TEARDOWN_TIMEOUT_MS = 20_000

export const PROTECTED_PATHS = [
	"/",
	"/bin",
	"/boot",
	"/dev",
	"/etc",
	"/home",
	"/lib",
	"/opt",
	"/proc",
	"/root",
	"/run",
	"/sbin",
	"/srv",
	"/sys",
	"/tmp",
	"/usr",
	"/var",
] as const

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const isSafeToRemove = (path: string): boolean => {
	const trimmed = path.trim().replace(/\/+$/, "")
	if (!trimmed.startsWith("/")) return false
	if (trimmed.includes("..")) return false
	if (PROTECTED_PATHS.some((protectedPath) => protectedPath === trimmed)) return false
	return trimmed.split("/").filter((segment) => segment.length > 0).length >= 2
}

export const selfExcludingPattern = (path: string): string => {
	const trimmed = path.replace(/\/+$/, "")
	const cut = trimmed.lastIndexOf("/")
	const head = trimmed.slice(0, cut + 1)
	const tail = trimmed.slice(cut + 1)
	if (tail.length === 0) return trimmed
	return `${head}[${tail.slice(0, 1)}]${tail.slice(1)}`
}

export type TeardownReport = {
	unitsRemoved: readonly string[]
	accountsRemoved: readonly string[]
	directoryRemoved: boolean
	processesLeft: number
	lingeringLeft: boolean
	remaining: readonly string[]
}

const listManagedUnits = async (
	transport: HostTransport,
	profile: HostProfile,
): Promise<string[]> => {
	const result = await transport.exec(
		`ls -1 ${shellQuote(profile.unitDir)} 2>/dev/null || true`,
		TEARDOWN_TIMEOUT_MS,
	)
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && isManagedUnit(line))
}

export const tearDownHost = async (
	transport: HostTransport,
	profile: HostProfile,
	instanceIds: readonly string[],
): Promise<TeardownReport> => {
	const remaining: string[] = []
	const units = await listManagedUnits(transport, profile)

	for (const unit of units) {
		await transport.exec(
			`${systemctl(profile, `disable --now ${shellQuote(unit)}`)} || true`,
			TEARDOWN_TIMEOUT_MS,
		)
	}
	for (const unit of units) {
		await transport.exec(`rm -f ${shellQuote(`${profile.unitDir}/${unit}`)}`, TEARDOWN_TIMEOUT_MS)
	}
	await transport.exec(systemctl(profile, "daemon-reload"), TEARDOWN_TIMEOUT_MS)
	await transport.exec(`${systemctl(profile, "reset-failed")} || true`, TEARDOWN_TIMEOUT_MS)

	if (isSafeToRemove(profile.instancesRoot)) {
		await transport.exec(
			`pkill -f ${shellQuote(selfExcludingPattern(profile.instancesRoot))} || true`,
			TEARDOWN_TIMEOUT_MS,
		)
	}

	const accountsRemoved: string[] = []
	if (usesPerInstanceUsers(profile)) {
		for (const instanceId of instanceIds) {
			const account = instanceUser(instanceId)
			const result = await transport.exec(
				`userdel -r ${shellQuote(account)} 2>/dev/null || userdel ${shellQuote(account)} 2>/dev/null || true`,
				TEARDOWN_TIMEOUT_MS,
			)
			if (result.exitCode === 0) accountsRemoved.push(account)
		}
	}

	let directoryRemoved = false
	if (isSafeToRemove(profile.instancesRoot)) {
		await transport.exec(`rm -rf ${shellQuote(profile.instancesRoot)}`, TEARDOWN_TIMEOUT_MS)
		const check = await transport.exec(
			`test -e ${shellQuote(profile.instancesRoot)} && printf present || printf gone`,
			TEARDOWN_TIMEOUT_MS,
		)
		directoryRemoved = check.stdout.trim() === "gone"
		if (!directoryRemoved) remaining.push(`${profile.instancesRoot} could not be removed`)
	} else {
		remaining.push(`${profile.instancesRoot} was refused as unsafe to remove`)
	}

	const leftoverUnits = await listManagedUnits(transport, profile)
	for (const unit of leftoverUnits) remaining.push(`${unit} is still installed`)

	const processes = await transport.exec(
		`pgrep -f ${shellQuote(selfExcludingPattern(profile.instancesRoot))} 2>/dev/null | grep -c . || true`,
		TEARDOWN_TIMEOUT_MS,
	)
	const processesLeft = Number.parseInt(processes.stdout.trim(), 10)
	const stillRunning = Number.isSafeInteger(processesLeft) && processesLeft > 0 ? processesLeft : 0
	if (stillRunning > 0) remaining.push(`${stillRunning} process(es) still running`)

	const lingering = await transport.exec(
		'loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || printf no',
		TEARDOWN_TIMEOUT_MS,
	)
	const lingeringLeft = profile.mode === "rootless" && lingering.stdout.trim() === "yes"

	return {
		unitsRemoved: units,
		accountsRemoved,
		directoryRemoved,
		processesLeft: stillRunning,
		lingeringLeft,
		remaining,
	}
}

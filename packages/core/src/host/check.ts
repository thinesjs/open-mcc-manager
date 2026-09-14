import {
	type HostCheckReport,
	type HostCheckResult,
	type HostMode,
	reportFrom,
} from "@open-mcc/contracts"
import type { HostTransport } from "@open-mcc/transport"
import { hostFact, readsAsEnforced, sandboxProbeCommand } from "./facts"
import { architectureForMachine } from "./mcc-release"
import { explainClientFailure } from "./provision"

export const CHECK_TIMEOUT_MS = 20_000

export const FORWARD_PROBE_PORT = 22

export const LINGER_COMMAND =
	'loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || printf no'

export const CLIENT_PROBE_COMMAND = "ldconfig -p 2>/dev/null | grep -c libicuuc || true"

const pass = (name: HostCheckResult["name"], detail: string): HostCheckResult => ({
	name,
	outcome: "pass",
	detail,
})

const fail = (name: HostCheckResult["name"], detail: string): HostCheckResult => ({
	name,
	outcome: "fail",
	detail,
})

const warn = (name: HostCheckResult["name"], detail: string): HostCheckResult => ({
	name,
	outcome: "warn",
	detail,
})

const skipped = (name: HostCheckResult["name"], detail: string): HostCheckResult => ({
	name,
	outcome: "skipped",
	detail,
})

export const unreachableReport = (reason: string): HostCheckReport =>
	reportFrom([
		fail("reachable", reason),
		skipped("systemd", "Not checked"),
		skipped("architecture", "Not checked"),
		skipped("client-runtime", "Not checked"),
		skipped("lingering", "Not checked"),
		skipped("confinement", "Not checked"),
		skipped("tcp-forwarding", "Not checked"),
	])

export const checkHostOverTransport = async (
	transport: HostTransport,
	mode: HostMode,
): Promise<HostCheckReport> => {
	const checks: HostCheckResult[] = [pass("reachable", "Connected and the host key matched")]

	const version = await transport.exec("systemctl --version | head -n 1", CHECK_TIMEOUT_MS)
	const release = hostFact(version.stdout)
	checks.push(
		release !== null
			? pass("systemd", release)
			: fail("systemd", "This host does not appear to run systemd"),
	)

	const machine = await transport.exec("uname -m", CHECK_TIMEOUT_MS)
	try {
		const architecture = architectureForMachine(machine.stdout)
		checks.push(pass("architecture", `${machine.stdout.trim()} uses the ${architecture} build`))
	} catch (error) {
		checks.push(
			fail("architecture", error instanceof Error ? error.message : "Unsupported architecture"),
		)
	}

	const runtime = await transport.exec(CLIENT_PROBE_COMMAND, CHECK_TIMEOUT_MS)
	const hasIcu = Number.parseInt(runtime.stdout.trim(), 10) > 0
	checks.push(
		hasIcu
			? pass("client-runtime", "libicu is installed")
			: fail(
					"client-runtime",
					explainClientFailure("Couldn't find a valid ICU package installed on the system."),
				),
	)

	if (mode === "rootless") {
		const linger = await transport.exec(LINGER_COMMAND, CHECK_TIMEOUT_MS)
		checks.push(
			linger.stdout.trim() === "yes"
				? pass("lingering", "Instances will keep running after logout")
				: fail("lingering", "Lingering is off, so instances would stop when the session ends"),
		)

		const probe = await transport.exec(sandboxProbeCommand(), CHECK_TIMEOUT_MS)
		checks.push(
			readsAsEnforced(probe.stdout)
				? pass("confinement", "This host's systemd confines instances from each other")
				: warn(
						"confinement",
						"This host's systemd ignores the unit's filesystem restrictions, so instances will not be isolated from each other",
					),
		)
	} else {
		checks.push(skipped("lingering", "Not used when running with root"))
		checks.push(skipped("confinement", "Enforced by the system manager"))
	}

	const forwards = await transport.canForward(FORWARD_PROBE_PORT, CHECK_TIMEOUT_MS)
	checks.push(
		forwards
			? pass("tcp-forwarding", "Live control can reach instances through this connection")
			: warn(
					"tcp-forwarding",
					"This host's sshd refuses port forwarding, so live instance control will not work. Set AllowTcpForwarding to yes to enable it.",
				),
	)

	return reportFrom(checks)
}

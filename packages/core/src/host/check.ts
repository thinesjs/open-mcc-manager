import {
	HOST_CHECK_NAMES,
	type HostCheckReport,
	type HostCheckResult,
	type NetworkStack,
	reportFrom,
} from "@open-mcc/contracts"
import type { HostTransport } from "@open-mcc/transport"
import { assertExhaustive } from "../lib/exhaustive"
import { hostFact } from "./facts"
import { architectureForMachine } from "./mcc-release"
import {
	formatPodmanVersion,
	HOST_FACTS_COMMAND,
	type HostPodmanFacts,
	meetsPodmanFloor,
	nextSubordinateRange,
	PODMAN_FLOOR,
	PODMAN_INFO_COMMAND,
	parseHostFacts,
	parsePodmanInfo,
	requiredStackFor,
} from "./podman-facts"
import { explainClientFailure } from "./provision"

export const CHECK_TIMEOUT_MS = 20_000

export const FORWARD_PROBE_PORT = 22

export const LINGER_COMMAND =
	'loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || printf no'

export const CLIENT_PROBE_COMMAND = "ldconfig -p 2>/dev/null | grep -c libicuuc || true"

export const ROOT_REFUSAL = "Bots can't run as root. Use a normal account."

export const USED_STORAGE_REFUSAL = "Podman on this account already has data. Use a fresh account."

export const STORAGE_SETTINGS_REFUSAL = "This account's Podman storage settings aren't supported."

const APT_INSTALL = "sudo apt-get install -y --no-install-recommends --no-remove"

export const PODMAN_INSTALL_COMMAND = `${APT_INSTALL} podman uidmap slirp4netns catatonit dbus-user-session`

const PACKAGE_FOR_STACK: Record<NetworkStack, string> = {
	slirp4netns: "slirp4netns",
	pasta: "passt",
}

export const networkHelperCommand = (stack: NetworkStack): string =>
	`${APT_INSTALL} ${PACKAGE_FOR_STACK[stack]}`

const SHELL_WORD = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

const accountWord = (account: string): string =>
	SHELL_WORD.test(account) ? account : `'${account.replace(/'/g, "'\\''")}'`

export const lingerCommand = (account: string): string =>
	`sudo loginctl enable-linger ${accountWord(account)}`

export const subordinateIdsCommand = (
	range: ReturnType<typeof nextSubordinateRange>,
	account: string,
): string =>
	`sudo usermod --add-subuids ${range.start}-${range.end} --add-subgids ${range.start}-${range.end} ${accountWord(account)}`

type Guidance = Partial<Pick<HostCheckResult, "command" | "hint">>

const resultWith =
	(outcome: HostCheckResult["outcome"]) =>
	(name: HostCheckResult["name"], detail: string, guidance: Guidance = {}): HostCheckResult => ({
		name,
		outcome,
		detail,
		command: guidance.command ?? null,
		hint: guidance.hint ?? null,
	})

const pass = resultWith("pass")

const fail = resultWith("fail")

const warn = resultWith("warn")

const skipped = resultWith("skipped")

const NOT_CHECKED = "Not checked"

export const unreachableReport = (reason: string): HostCheckReport =>
	reportFrom(
		HOST_CHECK_NAMES.map((name) =>
			name === "reachable" ? fail(name, reason) : skipped(name, NOT_CHECKED),
		),
	)

type PodmanInfo = ReturnType<typeof parsePodmanInfo>

const accountResult = (facts: HostPodmanFacts, info: PodmanInfo | null): HostCheckResult => {
	if (facts.uid === null) return fail("account", "Couldn't read this account's user id.")
	if (facts.uid === 0 || info?.rootless === false) return fail("account", ROOT_REFUSAL)
	return info?.rootless === true
		? pass("account", "Not root, and Podman runs rootless")
		: pass("account", "Not root. Rootless Podman is checked during setup.")
}

const systemdResult = (release: string | null, usableHome: boolean): HostCheckResult => {
	if (release === null) return fail("systemd", "This host does not appear to run systemd")
	if (!usableHome) {
		return fail("systemd", "This account's home folder can't be used.", {
			hint: "It must be the account's own home, and may only contain letters, digits, ., _, - and /.",
		})
	}
	return pass("systemd", release)
}

const architectureResult = (machine: string): HostCheckResult => {
	try {
		const architecture = architectureForMachine(machine)
		return pass("architecture", `${machine.trim()} uses the ${architecture} build`)
	} catch (error) {
		return fail("architecture", error instanceof Error ? error.message : "Unsupported architecture")
	}
}

const podmanResult = (facts: HostPodmanFacts): HostCheckResult => {
	if (facts.podman === null) {
		return fail("podman", "Podman isn't installed.", {
			command: PODMAN_INSTALL_COMMAND,
			hint: "This list is for Debian 12 and Ubuntu 24.04. On Debian 13, install passt in place of slirp4netns.",
		})
	}
	const version = formatPodmanVersion(facts.podman)
	if (!meetsPodmanFloor(facts.podman)) {
		return fail(
			"podman",
			`Needs Podman ${formatPodmanVersion(PODMAN_FLOOR)} or newer. This server has ${version}.`,
			{ hint: "Ubuntu 22.04 is too old. Debian 12, Debian 13 and Ubuntu 24.04 work." },
		)
	}
	return pass(
		"podman",
		`Podman ${version}`,
		facts.os.id === "ubuntu" ? { hint: "Ubuntu support is untested on a real Ubuntu host." } : {},
	)
}

const subordinateIdsResult = (facts: HostPodmanFacts, account: string): HostCheckResult =>
	facts.subuid.own && facts.subgid.own
		? pass("subordinate-ids", "Set up")
		: fail("subordinate-ids", "This account can't run containers yet.", {
				command: subordinateIdsCommand(
					nextSubordinateRange(facts.subuid.ranges, facts.subgid.ranges),
					account,
				),
				hint: "The range starts after the highest one in /etc/subuid and /etc/subgid. Ranges from a directory service (NSS) aren't seen here.",
			})

const networkHelperResult = (facts: HostPodmanFacts): HostCheckResult => {
	if (facts.podman === null || !meetsPodmanFloor(facts.podman)) {
		return skipped("network-helper", NOT_CHECKED)
	}
	const stack = requiredStackFor(facts.podman.major)
	return facts.helpers.includes(stack)
		? pass("network-helper", `Uses ${stack}`)
		: fail("network-helper", "A Podman network helper is missing.", {
				command: networkHelperCommand(stack),
			})
}

const storageResult = (facts: HostPodmanFacts, info: PodmanInfo | null): HostCheckResult => {
	if (facts.overrides.length > 0) {
		return fail("storage", STORAGE_SETTINGS_REFUSAL, {
			hint: "Unset XDG_CONFIG_HOME, XDG_DATA_HOME and CONTAINERS_STORAGE_CONF for this account, and remove rootless_storage_path from /etc/containers/storage.conf.",
		})
	}
	if (facts.storage === "fresh") return warn("storage", "Set up during provisioning.")
	if (info === null) return skipped("storage", NOT_CHECKED)
	const anotherDriver = info.driver !== null && info.driver !== "overlay"
	const unreadableAfterUse = info.driver === null && facts.storage === "used"
	return anotherDriver || unreadableAfterUse
		? fail("storage", USED_STORAGE_REFUSAL, {
				hint: "Provisioning sets up storage only for an account that has never run Podman.",
			})
		: pass("storage", "Set up")
}

const metadataResult = (reach: HostPodmanFacts["metadata"]): HostCheckResult => {
	switch (reach) {
		case "answered":
			return warn("cloud-metadata", "Bots on this server can reach its cloud metadata service.", {
				hint: "Don't give this server cloud roles or credentials.",
			})
		case "unanswered":
			return pass("cloud-metadata", "Not reachable")
		case "unchecked":
			return skipped("cloud-metadata", NOT_CHECKED, { hint: "curl isn't installed." })
		default:
			return assertExhaustive(reach)
	}
}

const readsPodmanInfo = (facts: HostPodmanFacts): boolean =>
	facts.uid !== null &&
	facts.uid !== 0 &&
	facts.podman !== null &&
	meetsPodmanFloor(facts.podman) &&
	facts.overrides.length === 0 &&
	facts.storage !== "fresh"

export const checkHostOverTransport = async (
	transport: HostTransport,
	account: string,
): Promise<HostCheckReport> => {
	const version = await transport.exec("systemctl --version | head -n 1", CHECK_TIMEOUT_MS)
	const machine = await transport.exec("uname -m", CHECK_TIMEOUT_MS)
	const facts = parseHostFacts((await transport.exec(HOST_FACTS_COMMAND, CHECK_TIMEOUT_MS)).stdout)
	const linger = await transport.exec(LINGER_COMMAND, CHECK_TIMEOUT_MS)
	const runtime = await transport.exec(CLIENT_PROBE_COMMAND, CHECK_TIMEOUT_MS)
	const info = readsPodmanInfo(facts)
		? parsePodmanInfo((await transport.exec(PODMAN_INFO_COMMAND, CHECK_TIMEOUT_MS)).stdout)
		: null
	const forwards = await transport.canForward(FORWARD_PROBE_PORT, CHECK_TIMEOUT_MS)

	return reportFrom([
		pass("reachable", "Connected and the host key matched"),
		accountResult(facts, info),
		systemdResult(hostFact(version.stdout), facts.usableHome),
		architectureResult(machine.stdout),
		linger.stdout.trim() === "yes"
			? pass("lingering", "On")
			: fail("lingering", "Bots would stop when you log out.", {
					command: lingerCommand(account),
				}),
		podmanResult(facts),
		facts.cgroupV2
			? pass("cgroups", "Supported")
			: fail("cgroups", "This server's system is too old for Podman.", {
					hint: "Podman needs cgroup v2.",
				}),
		subordinateIdsResult(facts, account),
		networkHelperResult(facts),
		storageResult(facts, info),
		forwards
			? pass("tcp-forwarding", "Live control can reach instances through this connection")
			: warn(
					"tcp-forwarding",
					"This host's sshd refuses port forwarding, so live instance control will not work. Set AllowTcpForwarding to yes to enable it.",
				),
		metadataResult(facts.metadata),
		Number.parseInt(runtime.stdout.trim(), 10) > 0
			? pass("client-runtime", "libicu is installed")
			: fail(
					"client-runtime",
					explainClientFailure("Couldn't find a valid ICU package installed on the system."),
				),
	])
}

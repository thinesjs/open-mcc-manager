import {
	LINGER_STEP_LABEL,
	lingerCommand,
	type NetworkStack,
	PROVISION_STEP_LABELS,
	type ProvisionStepLabel,
} from "@open-mcc/contracts"
import type { HostTransport } from "@open-mcc/transport"
import { ROOT_REFUSAL } from "./check"
import { hostFact, UNKNOWN_HOST_FACT } from "./facts"
import { type MccArchitecture, mccReleaseForMachine } from "./mcc-release"
import {
	formatPodmanVersion,
	HOST_FACTS_COMMAND,
	type HostPodmanFacts,
	meetsPodmanFloor,
	PODMAN_FLOOR,
	parseHostFacts,
	requiredStackFor,
	storageStepCommand,
} from "./podman-facts"
import { INSTANCES_ROOT, isUsableHome, systemctl, UNIT_DIR } from "./profile"
import {
	podmanImageId,
	type RuntimeImage,
	runtimeImageFor,
	runtimeImageReference,
} from "./runtime-image"
import { INSTANCE_UNIT_NAME, renderUnitTemplates, SUPPORTING_UNIT_NAMES } from "./unit-template"

export { INSTANCE_UNIT_NAME, SUPPORTING_UNIT_NAMES }

export class HostProvisioningFailedError extends Error {}

export const PROVISION_STEPS = PROVISION_STEP_LABELS

export type ProvisionStep = ProvisionStepLabel

export type ProvisionOptions = {
	onProgress?: ProvisionReporter
}

export type ProvisionResult = {
	osRelease: string
	osId: string | null
	osName: string | null
	networkStack: NetworkStack
	architecture: MccArchitecture
}

export type ProvisionProgress = {
	step: ProvisionStep
	index: number
	total: number
}

export type ProvisionReporter = (progress: ProvisionProgress) => void

export const PROVISION_STEP_TIMEOUT_MS = 15_000

export const PROVISION_DOWNLOAD_TIMEOUT_MS = 180_000

export const CLIENT_PROBE_TIMEOUT_MS = 30_000

export const CLIENT_BANNER = "Minecraft Console Client"

export const SYSTEM_COMMAND = [
	`printf 'uid=%s\\n' "$(id -u)"`,
	`printf 'home=%s\\n' "$(printf '%s' "$HOME" | tr -c '[:print:]' ' ')"`,
	`printf 'passwd-home=%s\\n' "$(getent passwd "$(id -un)" | cut -d: -f6 | head -n 1)"`,
	`printf 'systemd=%s\\n' "$(systemctl --version 2>/dev/null | head -n 1)"`,
	`(. /etc/os-release 2>/dev/null && printf 'os-id=%s\\nos-name=%s\\n' "$ID" "$PRETTY_NAME")`,
	"exit 0",
].join("\n")

const UID = /^[0-9]{1,10}$/

const lineValue = (lines: readonly string[], key: string): string | null => {
	const line = lines.find((each) => each.startsWith(`${key}=`))
	return line === undefined ? null : line.slice(key.length + 1)
}

export const parseSystem = (output: string) => {
	const lines = output.split("\n")
	const uid = lineValue(lines, "uid") ?? ""
	return {
		uid: UID.test(uid) ? Number(uid) : null,
		home: lineValue(lines, "home") ?? "",
		passwdHome: lineValue(lines, "passwd-home") ?? "",
		systemd: hostFact(lineValue(lines, "systemd") ?? ""),
		osId: hostFact(lineValue(lines, "os-id") ?? ""),
		osName: hostFact(lineValue(lines, "os-name") ?? ""),
	}
}

export const explainClientFailure = (output: string): string => {
	const firstLine = output.trim().split("\n")[0] ?? ""
	return firstLine.length > 0
		? `The installed client could not start: ${firstLine}`
		: "The installed client could not start, and reported nothing."
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const DOWNLOAD_ATTEMPTS = 3

export const DOWNLOAD_DEADLINE_SECONDS = 170

export const DOWNLOAD_FIRST_BACKOFF_SECONDS = 1

const RETRYABLE_HTTP_CODES = ["408", "429", "5??"] as const

const RETRYABLE_CURL_EXITS = [6, 7, 18, 28, 35, 52, 55, 56] as const

const TRANSIENT = [
	...RETRYABLE_HTTP_CODES.map((code) => `22:${code}`),
	...RETRYABLE_CURL_EXITS.map((exit) => `${exit}:*`),
].join("|")

export const clientDownloadCommand = (url: string): string =>
	[
		"dir=$(mktemp -d) || exit 1",
		`deadline=$(($(date +%s) + ${DOWNLOAD_DEADLINE_SECONDS}))`,
		`pause=${DOWNLOAD_FIRST_BACKOFF_SECONDS}`,
		"attempt=1",
		"while :; do",
		"	left=$((deadline - $(date +%s)))",
		'	[ "$left" -gt 0 ] || exit 28',
		`	code=$(curl -fsSL --max-time "$left" -w '%{http_code}' -o "$dir/mcc" ${shellQuote(url)})`,
		"	status=$?",
		'	[ "$status" -eq 0 ] && break',
		'	case "$status:$code" in',
		`	${TRANSIENT}) ;;`,
		'	*) exit "$status" ;;',
		"	esac",
		`	[ "$attempt" -lt ${DOWNLOAD_ATTEMPTS} ] || exit "$status"`,
		"	attempt=$((attempt + 1))",
		'	sleep "$pause"',
		"	pause=$((pause * 2))",
		"done",
		`printf '%s' "$dir"`,
	].join("\n")

export const imagePullCommand = (image: RuntimeImage): string =>
	`podman pull ${shellQuote(runtimeImageReference(image))}`

export const imageIdCommand = (image: RuntimeImage): string =>
	`podman image inspect --format '{{.Id}}' ${shellQuote(runtimeImageReference(image))}`

export const clientCheckCommand = (image: RuntimeImage): string =>
	`podman run --rm --network=none --pull=never --user 0:0 --read-only --cap-drop=all -e DOTNET_BUNDLE_EXTRACT_BASE_DIR=/tmp -v ${INSTANCES_ROOT}/bin:/opt/mcc:ro ${podmanImageId(image)} /opt/mcc/MinecraftClient --help < /dev/null 2>&1`

const step = async (
	transport: HostTransport,
	command: string,
	failure: string,
	timeoutMs: number = PROVISION_STEP_TIMEOUT_MS,
	stdin?: string,
): Promise<string> => {
	const result = await transport.exec(command, timeoutMs, stdin)
	if (result.exitCode !== 0)
		throw new HostProvisioningFailedError(`${failure}: ${result.stderr.trim()}`)
	return result.stdout.trim()
}

const readSystem = async (transport: HostTransport) => {
	const read = await transport.exec(SYSTEM_COMMAND, PROVISION_STEP_TIMEOUT_MS)
	if (read.exitCode !== 0) {
		throw new HostProvisioningFailedError(
			`Failed to read systemd and the connecting account: ${read.stderr.trim()}`,
		)
	}
	const system = parseSystem(read.stdout)
	if (system.uid === null)
		throw new HostProvisioningFailedError("Couldn't read this account's user id.")
	if (system.uid === 0) throw new HostProvisioningFailedError(ROOT_REFUSAL)
	if (system.systemd === null)
		throw new HostProvisioningFailedError("systemd is not available on this host")
	if (!isUsableHome(system.home, system.passwdHome)) {
		throw new HostProvisioningFailedError(
			"The remote home directory must be an absolute path containing only letters, digits, '.', '_', '-', and '/', and must be the account's own home",
		)
	}
	return { osRelease: system.systemd, osId: system.osId, osName: system.osName }
}

const assertLingerEnabled = async (transport: HostTransport): Promise<void> => {
	const result = await transport.exec(
		'loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || printf no',
		PROVISION_STEP_TIMEOUT_MS,
	)
	if (result.stdout.trim() === "yes") return
	const user = await transport
		.exec("id -un", PROVISION_STEP_TIMEOUT_MS)
		.then((r) => r.stdout.trim())
		.catch(() => "<user>")
	throw new HostProvisioningFailedError(
		`Instances would stop when this session ends because lingering is off for ${user}. Run this on the host, then provision again: ${lingerCommand(user)}`,
	)
}

const networkStackFor = (facts: HostPodmanFacts): NetworkStack => {
	if (facts.uid === null || facts.uid === 0) throw new HostProvisioningFailedError(ROOT_REFUSAL)
	if (facts.podman === null || !meetsPodmanFloor(facts.podman)) {
		throw new HostProvisioningFailedError(
			`Needs Podman ${formatPodmanVersion(PODMAN_FLOOR)} or newer.`,
		)
	}
	if (!facts.cgroupV2)
		throw new HostProvisioningFailedError("This server's system is too old for Podman.")
	if (!facts.subuid.own || !facts.subgid.own) {
		throw new HostProvisioningFailedError("This account can't run containers yet.")
	}
	const stack = requiredStackFor(facts.podman.major)
	if (!facts.helpers.includes(stack))
		throw new HostProvisioningFailedError("A Podman network helper is missing.")
	return stack
}

export const provisionHost = async (
	transport: HostTransport,
	options: ProvisionOptions = {},
): Promise<ProvisionResult> => {
	let completed = 0
	const advance = (): void => {
		const next = PROVISION_STEPS[completed]
		if (next) options.onProgress?.({ step: next, index: completed, total: PROVISION_STEPS.length })
		completed += 1
	}

	advance()
	const { osRelease, osId, osName } = await readSystem(transport)

	advance()
	await assertLingerEnabled(transport)

	advance()
	const networkStack = networkStackFor(
		parseHostFacts(await step(transport, HOST_FACTS_COMMAND, "Failed to read Podman's facts")),
	)

	advance()
	const storage = await transport.exec(storageStepCommand(), PROVISION_STEP_TIMEOUT_MS)
	if (storage.exitCode !== 0 || storage.stdout.trim() !== "ready") {
		throw new HostProvisioningFailedError(
			`Failed to set up container storage: ${storage.stdout.trim()} ${storage.stderr.trim()}`,
		)
	}

	advance()
	await step(
		transport,
		`install -d -m 0700 ${INSTANCES_ROOT} ${INSTANCES_ROOT}/bin ${INSTANCES_ROOT}/instances`,
		"Failed to create instances directory",
	)

	advance()
	const machine = await step(transport, "uname -m", "Failed to read the host machine architecture")
	const release = mccReleaseForMachine(machine)
	const image = runtimeImageFor(release.architecture)

	advance()
	const workDir = await step(
		transport,
		clientDownloadCommand(release.url),
		"Failed to download the Minecraft Console Client",
		PROVISION_DOWNLOAD_TIMEOUT_MS,
	)

	try {
		advance()
		await step(
			transport,
			`printf '%s  %s' ${shellQuote(release.sha256)} ${shellQuote(`${workDir}/mcc`)} | sha256sum -c -`,
			"The downloaded client did not match its expected checksum",
		)

		advance()
		await step(
			transport,
			`install -D -m 0755 ${shellQuote(`${workDir}/mcc`)} ${INSTANCES_ROOT}/bin/MinecraftClient`,
			"Failed to install the client",
		)
	} finally {
		await transport
			.exec(`rm -rf ${shellQuote(workDir)}`, PROVISION_STEP_TIMEOUT_MS)
			.catch(() => undefined)
	}

	advance()
	await step(
		transport,
		imagePullCommand(image),
		"Failed to download the runtime image",
		PROVISION_DOWNLOAD_TIMEOUT_MS,
	)

	advance()
	const pulled = await step(transport, imageIdCommand(image), "Failed to read the runtime image")
	if (pulled !== podmanImageId(image)) {
		throw new HostProvisioningFailedError(
			`The runtime image is ${hostFact(pulled) ?? UNKNOWN_HOST_FACT}, not ${podmanImageId(image)}`,
		)
	}

	advance()
	const probe = await transport.exec(clientCheckCommand(image), CLIENT_PROBE_TIMEOUT_MS)
	const probeOutput = `${probe.stdout}\n${probe.stderr}`
	if (!probeOutput.includes(CLIENT_BANNER)) {
		throw new HostProvisioningFailedError(explainClientFailure(probeOutput))
	}

	const templates = renderUnitTemplates({ networkStack, imageId: podmanImageId(image) })

	advance()
	await step(
		transport,
		`mkdir -p ${UNIT_DIR} && cat > ${UNIT_DIR}/${shellQuote(INSTANCE_UNIT_NAME)}`,
		"Failed to install the instance unit template",
		PROVISION_STEP_TIMEOUT_MS,
		templates[INSTANCE_UNIT_NAME],
	)

	advance()
	for (const name of SUPPORTING_UNIT_NAMES) {
		await step(
			transport,
			`cat > ${UNIT_DIR}/${shellQuote(name)}`,
			`Failed to install the ${name} unit template`,
			PROVISION_STEP_TIMEOUT_MS,
			templates[name],
		)
	}

	advance()
	await step(transport, systemctl("daemon-reload"), "Failed to reload systemd")

	return { osRelease, osId, osName, networkStack, architecture: release.architecture }
}

export { LINGER_STEP_LABEL }

import {
	type HostMode,
	LINGER_STEP_LABEL,
	PROVISION_STEP_LABELS,
	type ProvisionStepLabel,
	provisionStepLabels,
	ROOTLESS_PROVISION_STEP_LABELS,
} from "@open-mcc/contracts"
import type { HostTransport } from "@open-mcc/transport"
import {
	hostFact,
	OS_RELEASE_COMMAND,
	parseOsRelease,
	readSandboxing,
	UNKNOWN_HOST_FACT,
} from "./facts"
import { mccReleaseForMachine } from "./mcc-release"
import {
	type HostProfile,
	rootlessProfile,
	systemctl,
	systemProfile,
	usesPerInstanceUsers,
	validateHostPath,
} from "./profile"
import { INSTANCE_UNIT_NAME, renderUnitTemplates, SUPPORTING_UNIT_NAMES } from "./unit-template"

export { INSTANCE_UNIT_NAME, SUPPORTING_UNIT_NAMES }

export const PROVISION_STEPS = PROVISION_STEP_LABELS

export const ROOTLESS_PROVISION_STEPS = ROOTLESS_PROVISION_STEP_LABELS

export type ProvisionStep = ProvisionStepLabel

export type ProvisionOptions = {
	mode: HostMode
	onProgress?: ProvisionReporter
}

export type ProvisionResult = {
	osRelease: string
	profile: HostProfile
	sandboxed: boolean
	osId: string | null
	osName: string | null
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

export const explainClientFailure = (output: string): string => {
	if (/ICU/i.test(output)) {
		return "The client needs the libicu library, which this host does not have. Install it (Debian and Ubuntu: libicu; Alpine: icu-libs; RHEL and Fedora: libicu) and provision again."
	}
	const firstLine = output.trim().split("\n")[0] ?? ""
	return firstLine.length > 0
		? `The installed client could not start: ${firstLine}`
		: "The installed client could not start, and reported nothing."
}

export const validateInstancesRoot = (instancesRoot: string): string =>
	validateHostPath(instancesRoot, "instancesRoot")

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

const step = async (
	transport: HostTransport,
	command: string,
	failure: string,
	timeoutMs: number = PROVISION_STEP_TIMEOUT_MS,
	stdin?: string,
): Promise<string> => {
	const result = await transport.exec(command, timeoutMs, stdin)
	if (result.exitCode !== 0) throw new Error(`${failure}: ${result.stderr.trim()}`)
	return result.stdout.trim()
}

const resolveProfile = async (transport: HostTransport, mode: HostMode): Promise<HostProfile> => {
	if (mode === "system") return systemProfile()
	const home = await step(
		transport,
		'printf %s "$HOME"',
		"Failed to read the home directory of the connecting user",
	)
	return rootlessProfile(home)
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
	throw new Error(
		`Instances would stop when this session ends because lingering is off for ${user}. Run 'sudo loginctl enable-linger ${user}' on the host, then provision again.`,
	)
}

export const provisionHost = async (
	transport: HostTransport,
	options: ProvisionOptions,
): Promise<ProvisionResult> => {
	const steps = provisionStepLabels(options.mode)
	let completed = 0
	const advance = (): void => {
		const next = steps[completed]
		if (next) options.onProgress?.({ step: next, index: completed, total: steps.length })
		completed += 1
	}

	advance()
	const osRelease =
		hostFact(
			await step(
				transport,
				"systemctl --version | head -n 1",
				"systemd is not available on this host",
			),
		) ?? UNKNOWN_HOST_FACT

	const osRead = await transport.exec(OS_RELEASE_COMMAND, PROVISION_STEP_TIMEOUT_MS)
	const { osId, osName } = parseOsRelease(osRead.stdout)

	const profile = await resolveProfile(transport, options.mode)

	if (profile.mode === "rootless") {
		advance()
		await assertLingerEnabled(transport)
	}

	advance()
	const ownership = usesPerInstanceUsers(profile) ? "-o root -g root " : ""
	await step(
		transport,
		`install -d -m 0711 ${ownership}${shellQuote(`${profile.instancesRoot}/instances`)}`,
		"Failed to create instances directory",
	)

	advance()
	const machine = await step(transport, "uname -m", "Failed to read the host machine architecture")
	const release = mccReleaseForMachine(machine)

	advance()
	const workDir = await step(
		transport,
		`d=$(mktemp -d) && curl -fsSL ${shellQuote(release.url)} -o "$d/mcc" && printf '%s' "$d"`,
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
			`install -D -m 0755 ${shellQuote(`${workDir}/mcc`)} ${shellQuote(
				`${profile.instancesRoot}/bin/MinecraftClient`,
			)}`,
			"Failed to install the client",
		)
	} finally {
		await transport
			.exec(`rm -rf ${shellQuote(workDir)}`, PROVISION_STEP_TIMEOUT_MS)
			.catch(() => undefined)
	}

	advance()
	const probe = await transport.exec(
		`${shellQuote(`${profile.instancesRoot}/bin/MinecraftClient`)} --help < /dev/null 2>&1`,
		CLIENT_PROBE_TIMEOUT_MS,
	)
	const probeOutput = `${probe.stdout}\n${probe.stderr}`
	if (!probeOutput.includes(CLIENT_BANNER)) {
		throw new Error(explainClientFailure(probeOutput))
	}

	let sandboxed = true
	if (profile.mode === "rootless") {
		advance()
		sandboxed = await readSandboxing(transport, profile)
	}

	const templates = renderUnitTemplates(profile)

	advance()
	await step(
		transport,
		`${profile.mode === "rootless" ? `mkdir -p ${shellQuote(profile.unitDir)} && ` : ""}cat > ${shellQuote(
			`${profile.unitDir}/${INSTANCE_UNIT_NAME}`,
		)}`,
		"Failed to install the instance unit template",
		PROVISION_STEP_TIMEOUT_MS,
		templates[INSTANCE_UNIT_NAME],
	)

	advance()
	for (const name of SUPPORTING_UNIT_NAMES) {
		await step(
			transport,
			`cat > ${shellQuote(`${profile.unitDir}/${name}`)}`,
			`Failed to install the ${name} unit template`,
			PROVISION_STEP_TIMEOUT_MS,
			templates[name],
		)
	}

	advance()
	await step(transport, systemctl(profile, "daemon-reload"), "Failed to reload systemd")

	return { osRelease, profile, sandboxed, osId, osName }
}

export { LINGER_STEP_LABEL }

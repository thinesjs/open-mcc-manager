import type { HostTransport } from "@open-mcc/transport"
import { mccReleaseForMachine } from "./mcc-release"
import { UNIT_TEMPLATES } from "./unit-template"

export const SYSTEMD_UNIT_DIR = "/etc/systemd/system"

export const INSTANCE_UNIT_NAME = "open-mcc@.service"

export const SLEEP_UNIT_NAMES = [
	"open-mcc-sleep-stop@.service",
	"open-mcc-sleep-start@.service",
] as const

export const UNIT_TEMPLATE_PATH = `${SYSTEMD_UNIT_DIR}/${INSTANCE_UNIT_NAME}`

export const UNIT_TEMPLATE_INSTANCES_ROOT = "/srv/open-mcc"

export type ProvisionOptions = {
	instancesRoot: string
	onProgress?: ProvisionReporter
}

export type ProvisionResult = {
	osRelease: string
}

export const PROVISION_STEPS = [
	"Checking systemd",
	"Creating the instances directory",
	"Reading the host architecture",
	"Downloading the client",
	"Verifying the download",
	"Installing the client",
	"Installing the instance unit",
	"Installing the sleep units",
	"Reloading systemd",
] as const

export type ProvisionStep = (typeof PROVISION_STEPS)[number]

export type ProvisionProgress = {
	step: ProvisionStep
	index: number
	total: number
}

export type ProvisionReporter = (progress: ProvisionProgress) => void

export const PROVISION_STEP_TIMEOUT_MS = 15_000

export const PROVISION_DOWNLOAD_TIMEOUT_MS = 180_000

const INSTANCES_ROOT_PATTERN = /^\/[A-Za-z0-9._\-/]*$/

export const validateInstancesRoot = (instancesRoot: string): string => {
	if (!INSTANCES_ROOT_PATTERN.test(instancesRoot)) {
		throw new Error(
			"instancesRoot must be an absolute path containing only letters, digits, '.', '_', '-', and '/'",
		)
	}
	return instancesRoot
}

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

export const provisionHost = async (
	transport: HostTransport,
	options: ProvisionOptions,
): Promise<ProvisionResult> => {
	const instancesRoot = validateInstancesRoot(options.instancesRoot)
	let completed = 0
	const advance = (): void => {
		const next = PROVISION_STEPS[completed]
		if (next) options.onProgress?.({ step: next, index: completed, total: PROVISION_STEPS.length })
		completed += 1
	}

	advance()
	const osRelease = await step(
		transport,
		"systemctl --version | head -n 1",
		"systemd is not available on this host",
	)

	advance()
	await step(
		transport,
		`install -d -m 0711 -o root -g root ${shellQuote(`${instancesRoot}/instances`)}`,
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
				`${instancesRoot}/bin/MinecraftClient`,
			)}`,
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
		`cat > ${shellQuote(UNIT_TEMPLATE_PATH)}`,
		"Failed to install the instance unit template",
		PROVISION_STEP_TIMEOUT_MS,
		UNIT_TEMPLATES[INSTANCE_UNIT_NAME],
	)

	advance()
	for (const name of SLEEP_UNIT_NAMES) {
		await step(
			transport,
			`cat > ${shellQuote(`${SYSTEMD_UNIT_DIR}/${name}`)}`,
			`Failed to install the ${name} unit template`,
			PROVISION_STEP_TIMEOUT_MS,
			UNIT_TEMPLATES[name],
		)
	}

	advance()
	await step(transport, "systemctl daemon-reload", "Failed to reload systemd")

	return { osRelease }
}

export const assertInstancesRootMatchesUnitTemplate = (instancesRoot: string): string => {
	if (instancesRoot !== UNIT_TEMPLATE_INSTANCES_ROOT) {
		throw new Error(
			`INSTANCES_ROOT is ${instancesRoot} but the systemd unit template is fixed at ${UNIT_TEMPLATE_INSTANCES_ROOT}; the template is deliberately static, so these cannot differ`,
		)
	}
	return instancesRoot
}

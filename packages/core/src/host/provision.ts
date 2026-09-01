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
}

export type ProvisionResult = {
	osRelease: string
}

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

	const osRelease = await step(
		transport,
		"systemctl --version | head -n 1",
		"systemd is not available on this host",
	)

	await step(
		transport,
		`install -d -m 0711 -o root -g root ${shellQuote(`${instancesRoot}/instances`)}`,
		"Failed to create instances directory",
	)

	const machine = await step(transport, "uname -m", "Failed to read the host machine architecture")
	const release = mccReleaseForMachine(machine)

	await step(
		transport,
		`set -e; d=$(mktemp -d); trap 'rm -rf "$d"' EXIT; curl -fsSL ${shellQuote(
			release.url,
		)} -o "$d/mcc"; printf '%s  %s' ${shellQuote(
			release.sha256,
		)} "$d/mcc" | sha256sum -c -; install -D -m 0755 "$d/mcc" ${shellQuote(
			`${instancesRoot}/bin/MinecraftClient`,
		)}`,
		"Failed to install a verified Minecraft Console Client",
		PROVISION_DOWNLOAD_TIMEOUT_MS,
	)

	await step(
		transport,
		`cat > ${shellQuote(UNIT_TEMPLATE_PATH)}`,
		"Failed to install the instance unit template",
		PROVISION_STEP_TIMEOUT_MS,
		UNIT_TEMPLATES[INSTANCE_UNIT_NAME],
	)

	for (const name of SLEEP_UNIT_NAMES) {
		await step(
			transport,
			`cat > ${shellQuote(`${SYSTEMD_UNIT_DIR}/${name}`)}`,
			`Failed to install the ${name} unit template`,
			PROVISION_STEP_TIMEOUT_MS,
			UNIT_TEMPLATES[name],
		)
	}

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

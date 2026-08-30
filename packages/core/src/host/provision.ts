import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { HostTransport } from "@open-mcc/transport"
import { MCC_SHA256, MCC_VERSION, mccDownloadUrl } from "./mcc-release"

export const UNIT_TEMPLATE_PATH = "/etc/systemd/system/open-mcc@.service"

const UNIT_TEMPLATE = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"..",
		"..",
		"docker",
		"systemd",
		"open-mcc@.service",
	),
	"utf8",
)

export type ProvisionOptions = {
	instancesRoot: string
}

export type ProvisionResult = {
	osRelease: string
}

export const PROVISION_STEP_TIMEOUT_MS = 15_000

export const PROVISION_DOWNLOAD_TIMEOUT_MS = 180_000

export const INSTANCE_GROUP = "open-mcc"

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
		`groupadd -f ${shellQuote(INSTANCE_GROUP)}`,
		"Failed to create the instance group",
	)

	await step(
		transport,
		`usermod -aG ${shellQuote(INSTANCE_GROUP)} "$(id -un)"`,
		"Failed to add the connecting principal to the instance group",
	)

	await step(
		transport,
		`install -d -m 2770 -g ${shellQuote(INSTANCE_GROUP)} ${shellQuote(`${instancesRoot}/instances`)}`,
		"Failed to create instances directory",
	)

	await step(
		transport,
		`curl -fsSL ${shellQuote(mccDownloadUrl(MCC_VERSION))} -o /tmp/mcc-download`,
		"Failed to download the Minecraft Console Client",
		PROVISION_DOWNLOAD_TIMEOUT_MS,
	)

	await step(
		transport,
		`printf '%s  /tmp/mcc-download' ${shellQuote(MCC_SHA256)} | sha256sum -c -`,
		"Downloaded client failed its checksum",
	)

	await step(
		transport,
		`install -D -m 0755 /tmp/mcc-download ${shellQuote(`${instancesRoot}/bin/MinecraftClient`)} && rm -f /tmp/mcc-download`,
		"Failed to install the client",
	)

	await step(
		transport,
		`cat > ${shellQuote(UNIT_TEMPLATE_PATH)}`,
		"Failed to install the instance unit template",
		PROVISION_STEP_TIMEOUT_MS,
		UNIT_TEMPLATE,
	)

	await step(transport, "systemctl daemon-reload", "Failed to reload systemd")

	return { osRelease }
}

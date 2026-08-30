import type { HostTransport } from "@open-mcc/transport"

export type ProvisionOptions = {
	instancesRoot: string
}

export type ProvisionResult = {
	dockerVersion: string
}

export const PROVISION_STEP_TIMEOUT_MS = 120_000

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

export const provisionHost = async (
	transport: HostTransport,
	options: ProvisionOptions,
): Promise<ProvisionResult> => {
	const instancesRoot = validateInstancesRoot(options.instancesRoot)

	const version = await transport.exec("docker --version", PROVISION_STEP_TIMEOUT_MS)
	if (version.exitCode !== 0) {
		throw new Error(`Docker is not available on this host: ${version.stderr.trim()}`)
	}

	const mkdir = await transport.exec(
		`install -d -m 0770 ${shellQuote(`${instancesRoot}/instances`)}`,
		PROVISION_STEP_TIMEOUT_MS,
	)
	if (mkdir.exitCode !== 0) {
		throw new Error(`Failed to create instances directory: ${mkdir.stderr.trim()}`)
	}

	return { dockerVersion: version.stdout.trim() }
}

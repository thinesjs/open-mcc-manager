import type { HostTransport } from "@open-mcc/transport"

export type ProvisionOptions = {
	instancesRoot: string
}

export type ProvisionResult = {
	dockerVersion: string
}

const TIMEOUT_MS = 120_000

export const provisionHost = async (
	transport: HostTransport,
	options: ProvisionOptions,
): Promise<ProvisionResult> => {
	const version = await transport.exec("docker --version", TIMEOUT_MS)
	if (version.exitCode !== 0) {
		throw new Error(`Docker is not available on this host: ${version.stderr.trim()}`)
	}

	const mkdir = await transport.exec(
		`install -d -m 0770 ${options.instancesRoot}/instances`,
		TIMEOUT_MS,
	)
	if (mkdir.exitCode !== 0) {
		throw new Error(`Failed to create instances directory: ${mkdir.stderr.trim()}`)
	}

	return { dockerVersion: version.stdout.trim() }
}

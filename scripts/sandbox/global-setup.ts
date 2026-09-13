import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { GlobalSetupContext } from "vitest/node"
import { docker, HOST_IMAGE, REPOSITORY, removeRun, succeeded } from "./sandbox"

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
	succeeded(
		await docker(["info", "--format", "{{.CgroupVersion}}"]),
		"the sandbox suite needs a Docker daemon it can start privileged containers on, and docker info",
	)
	succeeded(
		await docker(["build", "--tag", HOST_IMAGE, join(REPOSITORY, "docker", "sandbox")], {
			timeoutMs: 900_000,
		}),
		"building the sandbox host image",
	)
	const runId = randomUUID().slice(0, 8)
	provide("sandboxRun", runId)
	return async () => {
		await removeRun(runId)
	}
}

import { randomUUID } from "node:crypto"
import type { GlobalSetupContext } from "vitest/node"
import { buildImage, docker, removeRun, SANDBOX_PLATFORM, succeeded } from "./sandbox"

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
	succeeded(
		await docker(["info", "--format", "{{.CgroupVersion}}"]),
		"the sandbox suite needs a Docker daemon it can start privileged containers on, and docker info",
	)
	const image = await buildImage({ target: "host", baseImage: null, platform: SANDBOX_PLATFORM })
	const run = randomUUID().slice(0, 8)
	provide("sandbox", { run, image })
	return async () => {
		await removeRun(run)
	}
}

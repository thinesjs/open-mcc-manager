import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { GlobalSetupContext } from "vitest/node"
import { docker, REPOSITORY, removeRun, succeeded } from "./sandbox"

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
	succeeded(
		await docker(["info", "--format", "{{.CgroupVersion}}"]),
		"the sandbox suite needs a Docker daemon it can start privileged containers on, and docker info",
	)
	const image = succeeded(
		await docker(["build", "--quiet", join(REPOSITORY, "docker", "sandbox")], {
			timeoutMs: 900_000,
		}),
		"building the sandbox host image",
	).trim()
	if (!IMAGE_ID.test(image)) {
		throw new Error(`building the sandbox host image printed no image id: ${image}`)
	}
	const run = randomUUID().slice(0, 8)
	provide("sandbox", { run, image })
	return async () => {
		await removeRun(run)
	}
}

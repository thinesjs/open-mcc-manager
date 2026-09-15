import type { FakeScript } from "@open-mcc/transport"
import { LINGER_COMMAND } from "./check"
import { MCC_ARCHITECTURES } from "./mcc-release"
import { HOST_FACTS_COMMAND, storageStepCommand } from "./podman-facts"
import { CLIENT_BANNER, clientCheckCommand, imageIdCommand, SYSTEM_COMMAND } from "./provision"
import { podmanImageId, runtimeImageFor } from "./runtime-image"

const answer = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 })

const keyValues = (values: Readonly<Record<string, string>>): string =>
	Object.entries(values)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n")

const SYSTEM = {
	uid: "1001",
	home: "/home/mcc",
	"passwd-home": "/home/mcc",
	systemd: "systemd 252",
	"os-id": "debian",
	"os-name": "Debian GNU/Linux 12 (bookworm)",
}

export const systemOutput = (values: Readonly<Record<string, string>> = {}): string =>
	keyValues({ ...SYSTEM, ...values })

const FACTS = {
	uid: "1001",
	podman: "podman version 4.3.1",
	storage: "fresh",
	cgroup: "cgroup2fs",
}

const CONTAINER_ACCESS = ["subuid=own 165536 65536", "subgid=own 165536 65536", "helper=slirp4netns"]

export const factsOutput = (
	values: Readonly<Record<string, string>> = {},
	access: readonly string[] = CONTAINER_ACCESS,
): string => [keyValues({ ...FACTS, ...values }), ...access].join("\n")

export const provisionableHost = (script: FakeScript = {}): FakeScript => ({
	[SYSTEM_COMMAND]: answer(systemOutput()),
	[LINGER_COMMAND]: answer("yes"),
	[HOST_FACTS_COMMAND]: answer(factsOutput()),
	[storageStepCommand()]: answer("ready"),
	...Object.fromEntries(
		MCC_ARCHITECTURES.flatMap((architecture) => {
			const image = runtimeImageFor(architecture)
			return [
				[imageIdCommand(image), answer(podmanImageId(image))] as const,
				[clientCheckCommand(image), answer(`${CLIENT_BANNER} v26.2`)] as const,
			]
		}),
	),
	...script,
})

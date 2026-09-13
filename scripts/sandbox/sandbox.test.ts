import { describe, expect, it } from "vitest"
import {
	docker,
	dockerRunArguments,
	hostRunArguments,
	killsAContainer,
	RUN_LABEL,
	reachesThisMachine,
	SANDBOX_LABEL,
	STOP_WITHOUT_KILLING,
} from "./sandbox"

describe("how a sandbox container may be taken down", () => {
	it.each([
		{ args: ["kill", "name"] },
		{ args: ["kill", "--signal", "SIGRTMIN+3", "name"] },
		{ args: ["rm", "--force", "name"] },
		{ args: ["rm", "-f", "name"] },
		{ args: ["rm", "-vf", "name"] },
		{ args: ["container", "rm", "--force", "name"] },
		{ args: ["stop", "name"] },
		{ args: ["stop", "--timeout", "60", "name"] },
		{ args: ["container", "stop", "name"] },
	])("refuses $args, which kills a container or can escalate to a kill", ({ args }) => {
		expect(killsAContainer(args)).toBe(true)
	})

	it("refuses them on the way to docker, not only when asked", async () => {
		await expect(docker(["rm", "--force", "name"])).rejects.toThrow("never killed or forced")
	})

	it("still lets the harness stop a container, remove it, and run rm inside one", () => {
		expect(killsAContainer([...STOP_WITHOUT_KILLING, "name"])).toBe(false)
		expect(killsAContainer(["rm", "--volumes", "name"])).toBe(false)
		expect(killsAContainer(["exec", "name", "rm", "-rf", "/root/.ssh"])).toBe(false)
	})
})

describe("what a sandbox container may see of the machine running the suite", () => {
	it.each([
		{ args: ["-v", "/Users/someone:/host"] },
		{ args: ["-v/Users/someone:/host"] },
		{ args: ["--volume", "/Users/someone/.ssh:/root/.ssh"] },
		{ args: ["--volume=/Users/someone:/host"] },
		{ args: ["--mount", "type=bind,source=/,target=/host"] },
		{ args: ["--volumes-from", "some-other-container"] },
		{ args: ["--env", "DOCKER_HOST=unix:///var/run/docker.sock"] },
	])("refuses $args", ({ args }) => {
		expect(reachesThisMachine(["run", "--detach", ...args, "image"])).toBe(true)
	})

	it("refuses them on the way to docker, not only when asked", async () => {
		await expect(docker(["run", "-v", "/Users/someone:/host", "image"])).rejects.toThrow(
			"may not see this machine's files",
		)
	})

	it("still lets a host and a Docker machine start, and lets their anonymous volumes go with them", () => {
		expect(reachesThisMachine(hostRunArguments("name", "run"))).toBe(false)
		expect(reachesThisMachine(dockerRunArguments("name", "run"))).toBe(false)
		expect(reachesThisMachine(["rm", "--volumes", "name"])).toBe(false)
	})

	it.each([
		{ kind: "host", args: hostRunArguments("name", "run") },
		{ kind: "docker", args: dockerRunArguments("name", "run") },
	])(
		"labels every $kind it starts, so a run can find and remove what it left",
		({ kind, args }) => {
			expect(args).toContain(`${SANDBOX_LABEL}=${kind}`)
			expect(args).toContain(`${RUN_LABEL}=run`)
		},
	)
})

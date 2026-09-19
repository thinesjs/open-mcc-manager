import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	checkoutFiles,
	DOCKER_IMAGE,
	docker,
	dockerRunArguments,
	hostRunArguments,
	imageBuildArguments,
	killsAContainer,
	REPOSITORY,
	RUN_LABEL,
	reachesThisMachine,
	SANDBOX_LABEL,
	STOP_WITHOUT_KILLING,
	settled,
} from "./sandbox"

const IMAGE = "sha256:0123456789abcdef"

describe("booting a Podman host", () => {
	const STORAGE = "/home/pod1/.local/share/containers:uid=2001,gid=2001,mode=0700"

	it("gives an account its own container storage on a tmpfs, which names no path on this machine", () => {
		const args = hostRunArguments("name", "run", IMAGE, [STORAGE], null)

		expect(args[args.indexOf(STORAGE) - 1]).toBe("--tmpfs")
		expect(args.indexOf(STORAGE)).toBeLessThan(args.indexOf("--"))
		expect(reachesThisMachine(args)).toBe(false)
		expect(args.at(-1)).toBe(IMAGE)
	})

	it("boots on the platform the run asks for, among docker's own options", () => {
		const args = hostRunArguments("name", "run", IMAGE, [], "linux/amd64")
		const at = args.indexOf("--platform")

		expect(args.slice(at, at + 2)).toEqual(["--platform", "linux/amd64"])
		expect(at).toBeLessThan(args.indexOf("--"))
	})

	it("boots on this machine's own platform when none is asked for", () => {
		expect(hostRunArguments("name", "run", IMAGE, [], null)).not.toContain("--platform")
	})
})

describe("building a sandbox host image", () => {
	const CONTEXT = join(REPOSITORY, "docker", "sandbox")

	it("builds the plain host from the sandbox directory, on its default base image", () => {
		expect(imageBuildArguments({ target: "host", baseImage: null, platform: null })).toEqual([
			"build",
			"--quiet",
			"--target",
			"host",
			CONTEXT,
		])
	})

	it("builds a Podman host on the base image and platform asked for", () => {
		expect(
			imageBuildArguments({
				target: "podman-host",
				baseImage: "debian:trixie-20250908",
				platform: "linux/amd64",
			}),
		).toEqual([
			"build",
			"--quiet",
			"--target",
			"podman-host",
			"--build-arg",
			"BASE_IMAGE=debian:trixie-20250908",
			"--platform",
			"linux/amd64",
			CONTEXT,
		])
	})
})

describe("how a sandbox container may be taken down", () => {
	it.each([
		{ args: ["kill", "name"] },
		{ args: ["kill", "--signal", "SIGRTMIN+3", "name"] },
		{ args: ["rm", "--force", "name"] },
		{ args: ["rm", "--force=true", "name"] },
		{ args: ["rm", "-f", "name"] },
		{ args: ["rm", "-vf", "name"] },
		{ args: ["container", "rm", "--force", "name"] },
		{ args: ["container", "remove", "-f", "name"] },
		{ args: ["restart", "name"] },
		{ args: ["container", "restart", "name"] },
		{ args: ["stop", "name"] },
		{ args: ["stop", "--timeout", "60", "name"] },
		{ args: ["stop", "--timeout", "-1", "--signal", "KILL", "name"] },
		{ args: ["stop", "--timeout", "-1", "--signal=KILL", "name"] },
		{ args: ["stop", "--timeout", "-1", "-s", "KILL", "name"] },
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
		expect(killsAContainer(["container", "remove", "--volumes", "name"])).toBe(false)
		expect(killsAContainer(["exec", "name", "rm", "-rf", "/root/.ssh"])).toBe(false)
	})
})

describe("what a sandbox container may see of the machine running the suite", () => {
	it.each([
		{ args: ["-v", "/Users/someone:/host"] },
		{ args: ["-v/Users/someone:/host"] },
		{ args: ["-dv", "/Users/someone:/host"] },
		{ args: ["--volume", "/Users/someone/.ssh:/root/.ssh"] },
		{ args: ["--volume=/Users/someone:/host"] },
		{ args: ["--mount", "type=bind,source=/,target=/host"] },
		{ args: ["--volumes-from", "some-other-container"] },
		{ args: ["--env", "DOCKER_HOST=unix:///var/run/docker.sock"] },
	])("refuses $args", ({ args }) => {
		expect(reachesThisMachine(["run", "--detach", ...args, "image"])).toBe(true)
	})

	it.each([
		{ args: ["cp", "/Users/someone/.ssh", "name:/root/.ssh"] },
		{ args: ["cp", "-", "name:/tmp"] },
		{ args: ["container", "cp", "/Users/someone", "name:/host"] },
		{ args: ["cp", "name:/etc/passwd", "/Users/someone/.ssh/authorized_keys"] },
	])("refuses $args, which moves files between this machine and a container", ({ args }) => {
		expect(reachesThisMachine(args)).toBe(true)
	})

	it("refuses them on the way to docker, not only when asked", async () => {
		await expect(docker(["run", "-v", "/Users/someone:/host", "image"])).rejects.toThrow(
			"may not see this machine's files",
		)
	})

	it.each([
		{ args: ["exec", "name", "grep", "-v", "x", "f"] },
		{ args: ["exec", "name", "cp", "-av", "/checkout", "/x"] },
		{ args: ["exec", "name", "tar", "-xvf", "-", "-C", "/checkout"] },
	])("allows $args, whose -v runs inside a container and mounts nothing", ({ args }) => {
		expect(reachesThisMachine(args)).toBe(false)
	})

	it("still lets a host and a Docker machine start, and lets their anonymous volumes go with them", () => {
		expect(reachesThisMachine(hostRunArguments("name", "run", IMAGE))).toBe(false)
		expect(reachesThisMachine(dockerRunArguments("name", "run"))).toBe(false)
		expect(reachesThisMachine(["rm", "--volumes", "name"])).toBe(false)
		expect(reachesThisMachine(["exec", "name", "cp", "-a", "/checkout", "/fresh"])).toBe(false)
	})

	it.each([
		{ kind: "host", args: hostRunArguments("name", "run", IMAGE) },
		{ kind: "docker", args: dockerRunArguments("name", "run") },
	])(
		"labels every $kind it starts, so a run can find and remove what it left",
		({ kind, args }) => {
			expect(args).toContain(`${SANDBOX_LABEL}=${kind}`)
			expect(args).toContain(`${RUN_LABEL}=run`)
		},
	)
})

describe("which sandbox host it boots", () => {
	it("boots the image this run built, by its id, never a tag another run could move", () => {
		expect(hostRunArguments("name", "run", IMAGE).at(-1)).toBe(IMAGE)
	})
})

describe("where the harness's own run calls end docker's options", () => {
	it.each([
		{ kind: "host", args: hostRunArguments("name", "run", IMAGE), image: IMAGE },
		{ kind: "docker", args: dockerRunArguments("name", "run"), image: DOCKER_IMAGE },
	])("passes -- right before the $kind image, so the mount scan stops there", ({ args, image }) => {
		expect(args.at(-2)).toBe("--")
		expect(args.at(-1)).toBe(image)
	})

	it("allows a -v in the command after --, which runs inside the container and mounts nothing", () => {
		expect(reachesThisMachine(["run", "--detach", "--", IMAGE, "cp", "-av", "/a", "/b"])).toBe(
			false,
		)
	})
})

describe("when a sandbox host counts as booted", () => {
	it.each([
		{ state: "running" },
		{ state: "degraded" },
		{ state: "maintenance" },
		{ state: "stopping" },
	])("stops waiting once systemd says $state", ({ state }) => {
		expect(settled(state)).toBe(true)
	})

	it.each([{ state: "offline" }, { state: "initializing" }, { state: "starting" }, { state: "" }])(
		"keeps waiting while systemd says '$state', which it also says before it has started",
		({ state }) => {
			expect(settled(state)).toBe(false)
		},
	)
})

describe("the copy of the checkout the installer runs from", () => {
	const made: string[] = []

	afterEach(() => {
		for (const each of made.splice(0)) rmSync(each, { force: true, recursive: true })
	})

	it("leaves out a listed path deleted from the working tree, so tar is never asked for it", () => {
		const root = mkdtempSync(join(tmpdir(), "checkout-"))
		made.push(root)
		mkdirSync(join(root, "scripts"))
		writeFileSync(join(root, "scripts", "install.sh"), "")
		symlinkSync("nowhere", join(root, "dangling"))

		expect(checkoutFiles("scripts/install.sh\0deleted.ts\0dangling\0", root)).toBe(
			"scripts/install.sh\0dangling\0",
		)
	})
})

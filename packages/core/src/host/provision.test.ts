import { spawnSync } from "node:child_process"
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeTransport, type FakeScript } from "@open-mcc/transport"
import { afterEach, describe, expect, it } from "vitest"
import { LINGER_COMMAND } from "./check"
import { HOST_FACTS_COMMAND, STORAGE_CONF, storageStepCommand } from "./podman-facts"
import {
	clientCheckCommand,
	explainClientFailure,
	imageIdCommand,
	imagePullCommand,
	PROVISION_STEPS,
	parseSystem,
	provisionHost,
	SYSTEM_COMMAND,
} from "./provision"
import { factsOutput, provisionableHost, systemOutput } from "./provisionable-host"
import { runtimeImageFor } from "./runtime-image"

const answer = (stdout: string, exitCode = 0) => ({ stdout, stderr: "", exitCode })

const ARM64 = runtimeImageFor("arm64")

const ON_ARM64: FakeScript = { "uname -m": answer("aarch64\n") }

const connected = async (script: FakeScript = {}) => {
	const transport = createFakeTransport(provisionableHost(script))
	await transport.connect({
		hostname: "h",
		port: 22,
		username: "mcc",
		privateKey: "k",
		expectedFingerprint: "f",
		timeoutMs: 1000,
	})
	return transport
}

const refusingChecksum = async () => {
	const transport = await connected()
	const original = transport.exec
	transport.exec = async (command: string, timeoutMs: number, stdin?: string) =>
		command.includes("sha256sum")
			? { stdout: "", stderr: "FAILED", exitCode: 1 }
			: await original(command, timeoutMs, stdin)
	return transport
}

const made: string[] = []

afterEach(() => {
	for (const each of made.splice(0)) rmSync(each, { force: true, recursive: true })
})

const scratchHome = (): string => {
	const home = mkdtempSync(join(tmpdir(), "provision-"))
	made.push(home)
	return home
}

const withPodmanReporting = (home: string, info: string): string => {
	const bin = join(home, "bin")
	mkdirSync(bin)
	writeFileSync(join(bin, "podman"), `#!/bin/sh\nprintf '%s\\n' '${info}'\n`)
	chmodSync(join(bin, "podman"), 0o755)
	return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`
}

const storageCommandIssued = async (): Promise<string> => {
	const transport = await connected()
	await provisionHost(transport)
	const command = transport.commands.find((each) => each === storageStepCommand())
	if (command === undefined) throw new Error("provisioning issued no storage step")
	return command
}

describe("provisionHost", () => {
	it("never asks the host about docker, which it no longer needs", async () => {
		const transport = await connected()

		const result = await provisionHost(transport)

		expect(transport.commands.some((command) => command.startsWith("docker"))).toBe(false)
		expect(result.osRelease).toEqual(expect.any(String))
	})

	it("runs the fifteen steps, each with the command and deadline the runtime needs, in order", async () => {
		const transport = await connected(ON_ARM64)
		const original = transport.exec
		let current = ""
		const issued: [string, string, number][] = []
		transport.exec = async (command: string, timeoutMs: number, stdin?: string) => {
			issued.push([current, command, timeoutMs])
			return await original(command, timeoutMs, stdin)
		}

		await provisionHost(transport, {
			onProgress: (progress) => {
				current = progress.step
			},
		})

		expect(issued).toEqual([
			["Checking systemd", SYSTEM_COMMAND, 15_000],
			["Checking that instances survive a logout", LINGER_COMMAND, 15_000],
			["Checking Podman", HOST_FACTS_COMMAND, 15_000],
			["Setting up container storage", storageStepCommand(), 15_000],
			[
				"Creating the instances directory",
				'install -d -m 0700 "$HOME"/.local/share/open-mcc "$HOME"/.local/share/open-mcc/bin "$HOME"/.local/share/open-mcc/instances',
				15_000,
			],
			["Reading the host architecture", "uname -m", 15_000],
			["Downloading the client", expect.stringContaining("curl -fsSL"), 180_000],
			["Verifying the download", expect.stringContaining("sha256sum -c"), 15_000],
			["Installing the client", expect.stringContaining("install -D -m 0755"), 15_000],
			["Installing the client", expect.stringMatching(/^rm -rf /), 15_000],
			["Downloading the runtime image", imagePullCommand(ARM64), 180_000],
			["Verifying the runtime image", imageIdCommand(ARM64), 15_000],
			["Checking the client runs", clientCheckCommand(ARM64), 30_000],
			["Installing the instance unit", expect.stringContaining("'open-mcc@.service'"), 15_000],
			[
				"Installing the sleep units",
				expect.stringContaining("'open-mcc-sleep-stop@.service'"),
				15_000,
			],
			[
				"Installing the sleep units",
				expect.stringContaining("'open-mcc-sleep-start@.service'"),
				15_000,
			],
			["Installing the sleep units", expect.stringContaining("'open-mcc-auth@.service'"), 15_000],
			[
				"Reloading systemd",
				"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user daemon-reload",
				15_000,
			],
		])
	})

	it("reports every step it is about to take, in order", async () => {
		const transport = await connected()

		const seen: string[] = []
		await provisionHost(transport, { onProgress: (progress) => seen.push(progress.step) })

		expect(seen).toEqual([...PROVISION_STEPS])
	})

	it("never installs a client whose checksum did not match", async () => {
		const transport = await refusingChecksum()

		await expect(provisionHost(transport)).rejects.toThrow(/checksum/i)
		expect(transport.commands.some((command) => command.includes("install -D"))).toBe(false)
	})

	it("removes the downloaded file even when the checksum rejects it", async () => {
		const transport = await refusingChecksum()

		await expect(provisionHost(transport)).rejects.toThrow()
		expect(transport.commands.some((command) => command.startsWith("rm -rf"))).toBe(true)
	})

	it("downloads into a private temporary directory rather than a guessable path", async () => {
		const transport = await connected()

		await provisionHost(transport)

		const download = transport.commands.find((command) => command.includes("curl -fsSL"))
		expect(download).toContain("mktemp -d")
		expect(transport.commands.some((command) => command.includes("/tmp/mcc-download"))).toBe(false)
	})

	it("★ records our own Unknown for a systemd line it cannot trust", async () => {
		const transport = await connected({
			[SYSTEM_COMMAND]: answer(
				systemOutput({ systemd: `systemd 252 \u001b[31m${"x".repeat(200)}` }),
			),
		})

		expect((await provisionHost(transport)).osRelease).toBe("Unknown")
	})

	it("records the systemd version and the distribution the host names", async () => {
		const transport = await connected()

		expect(await provisionHost(transport)).toMatchObject({
			osRelease: "systemd 252",
			osId: "debian",
			osName: "Debian GNU/Linux 12 (bookworm)",
		})
	})

	it("refuses a host where systemd does not answer, before anything else", async () => {
		const transport = await connected({ [SYSTEM_COMMAND]: answer(systemOutput({ systemd: "" })) })

		await expect(provisionHost(transport)).rejects.toThrow(/systemd/)
		expect(transport.commands).toEqual([SYSTEM_COMMAND])
	})

	it("refuses a root account at its first step, before anything else", async () => {
		const transport = await connected({ [SYSTEM_COMMAND]: answer(systemOutput({ uid: "0" })) })

		await expect(provisionHost(transport)).rejects.toThrow(
			"Bots can't run as root. Use a normal account.",
		)
		expect(transport.commands).toEqual([SYSTEM_COMMAND])
	})

	it("installs the build matching the host's own architecture, not a fixed one", async () => {
		const transport = await connected(ON_ARM64)

		await provisionHost(transport)

		const download = transport.commands.find((command) => command.includes("curl -fsSL"))
		if (download === undefined) throw new Error("no download step was issued")
		expect(download).toContain("linux-arm64")
		expect(download).not.toContain("linux-x64")
	})

	it("refuses to provision a host whose architecture has no published build", async () => {
		const transport = await connected({ "uname -m": answer("riscv64") })

		await expect(provisionHost(transport)).rejects.toThrow(/riscv64/)
		expect(transport.commands.some((command) => command.includes("curl -fsSL"))).toBe(false)
		expect(transport.commands.some((command) => command.includes("podman pull"))).toBe(false)
	})

	it("delivers the unit template as stdin into the user manager's own directory", async () => {
		const transport = await connected()

		await provisionHost(transport)

		const command = transport.commands.find((each) => each.includes("open-mcc@.service"))
		expect(command).toBe(
			`mkdir -p "$HOME"/.config/systemd/user && cat > "$HOME"/.config/systemd/user/'open-mcc@.service'`,
		)
		expect(transport.stdins.some((each) => each.includes("RestartPreventExitStatus=4"))).toBe(true)
	})
})

describe("checking Podman before provisioning touches it", () => {
	it("records the network stack Podman 4 needs", async () => {
		const transport = await connected()

		expect((await provisionHost(transport)).networkStack).toBe("slirp4netns")
	})

	it("records the network stack Podman 5 needs", async () => {
		const transport = await connected({
			[HOST_FACTS_COMMAND]: answer(
				factsOutput({ podman: "podman version 5.4.2" }, [
					"subuid=own",
					"subuid-end=231072",
					"subgid=own",
					"subgid-end=231072",
					"helper=pasta",
				]),
			),
		})

		expect((await provisionHost(transport)).networkStack).toBe("pasta")
	})

	it.each([
		["no Podman", factsOutput({ podman: "" })],
		["a Podman older than 4.3.1", factsOutput({ podman: "podman version 4.3.0" })],
		["cgroup v1", factsOutput({ cgroup: "tmpfs" })],
		["a root account", factsOutput({ uid: "0" })],
		[
			"no subordinate uids",
			factsOutput({}, ["subgid=own", "subgid-end=231072", "helper=slirp4netns"]),
		],
		[
			"no subordinate gids",
			factsOutput({}, ["subuid=own", "subuid-end=231072", "helper=slirp4netns"]),
		],
		[
			"only the helper another Podman major needs",
			factsOutput({}, [
				"subuid=own",
				"subuid-end=231072",
				"subgid=own",
				"subgid-end=231072",
				"helper=pasta",
			]),
		],
	])("refuses %s before it sets up storage", async (_case, facts) => {
		const transport = await connected({ [HOST_FACTS_COMMAND]: answer(facts) })

		await expect(provisionHost(transport)).rejects.toThrow()
		expect(transport.commands).not.toContain(storageStepCommand())
		expect(transport.commands.some((command) => command.includes("install -d"))).toBe(false)
	})
})

describe("setting up container storage", () => {
	it("starts no Podman runtime before the storage step", async () => {
		const transport = await connected()

		await provisionHost(transport)

		const storageAt = transport.commands.indexOf(storageStepCommand())
		expect(storageAt).toBeGreaterThan(0)
		expect(
			transport.commands.slice(0, storageAt).filter((command) => command.includes("podman")),
		).toEqual([HOST_FACTS_COMMAND])
	})

	it("stops, and pulls nothing, when the storage step refuses the account", async () => {
		const transport = await connected({ [storageStepCommand()]: answer("used", 1) })

		await expect(provisionHost(transport)).rejects.toThrow(/storage/i)
		expect(transport.commands.some((command) => command.includes("podman pull"))).toBe(false)
		expect(transport.commands.some((command) => command.includes("install -d"))).toBe(false)
	})

	it("writes storage.conf on a fresh account through a temporary file and a rename", async () => {
		const command = await storageCommandIssued()
		const home = scratchHome()

		const ran = spawnSync("/bin/sh", ["-c", command], {
			env: { HOME: home, PATH: withPodmanReporting(home, "true overlay") },
		})

		expect(ran.stdout.toString().trim(), ran.stderr.toString()).toBe("ready")
		expect(readFileSync(join(home, ".config/containers/storage.conf"), "utf8")).toBe(STORAGE_CONF)
		expect(readdirSync(join(home, ".config/containers"))).toEqual(["storage.conf"])
		expect(command).toContain("mktemp")
		expect(command).toContain("mv -f")
	})

	it("writes nothing on an account that has already run Podman", async () => {
		const command = await storageCommandIssued()
		const home = scratchHome()
		mkdirSync(join(home, ".local/share/containers/storage/overlay"), { recursive: true })

		const ran = spawnSync("/bin/sh", ["-c", command], {
			env: { HOME: home, PATH: withPodmanReporting(home, "true vfs") },
		})

		expect(ran.status).not.toBe(0)
		expect(ran.stdout.toString().trim()).toBe("used")
		expect(statSync(home).isDirectory()).toBe(true)
		expect(readdirSync(home)).not.toContain(".config")
	})

	it("proceeds without writing when storage.conf is already the manager's", async () => {
		const command = await storageCommandIssued()
		const home = scratchHome()
		mkdirSync(join(home, ".config/containers"), { recursive: true })
		const conf = join(home, ".config/containers/storage.conf")
		writeFileSync(conf, STORAGE_CONF)
		const before = statSync(conf)

		const ran = spawnSync("/bin/sh", ["-c", command], {
			env: { HOME: home, PATH: withPodmanReporting(home, "true overlay") },
		})

		expect(ran.stdout.toString().trim(), ran.stderr.toString()).toBe("ready")
		expect(statSync(conf).ino).toBe(before.ino)
		expect(statSync(conf).mtimeMs).toBe(before.mtimeMs)
	})
})

describe("the runtime image", () => {
	it("pulls the pinned image by manifest digest, for the host's own architecture", async () => {
		const transport = await connected(ON_ARM64)

		await provisionHost(transport)

		expect(imagePullCommand(ARM64)).toBe(
			"podman pull 'mcr.microsoft.com/dotnet/runtime-deps@sha256:003addb8550309e7cd6886ff29175c4c6d926cb920eb9966bda388fe9d682062'",
		)
		expect(transport.commands).toContain(imagePullCommand(ARM64))
		expect(transport.commands).not.toContain(imagePullCommand(runtimeImageFor("x64")))
	})

	it("reads back the ID of the image it pulled", () => {
		expect(imageIdCommand(ARM64)).toBe(
			"podman image inspect --format '{{.Id}}' 'mcr.microsoft.com/dotnet/runtime-deps@sha256:003addb8550309e7cd6886ff29175c4c6d926cb920eb9966bda388fe9d682062'",
		)
	})

	it("refuses an image whose ID is not the pinned one, and never runs it", async () => {
		const transport = await connected({
			...ON_ARM64,
			[imageIdCommand(ARM64)]: answer(
				"56e3d8542b4091c81816101e95875e32ec981577e669112c479a57d4003e4c29",
			),
		})

		await expect(provisionHost(transport)).rejects.toThrow(/runtime image/i)
		expect(transport.commands.some((command) => command.includes("podman run"))).toBe(false)
		expect(transport.commands.some((command) => command.includes("daemon-reload"))).toBe(false)
	})

	it("stops at the pull when it fails, with its own failure, and never checks the image's ID", async () => {
		const transport = await connected({
			...ON_ARM64,
			[imagePullCommand(ARM64)]: {
				stdout: "",
				stderr: "Error: initializing source: connection refused",
				exitCode: 125,
			},
		})
		const seen: string[] = []

		await expect(
			provisionHost(transport, { onProgress: (progress) => seen.push(progress.step) }),
		).rejects.toThrow(/^Failed to download the runtime image: .*connection refused/)
		expect(seen.at(-1)).toBe("Downloading the runtime image")
		expect(transport.commands).not.toContain(imageIdCommand(ARM64))
		expect(transport.commands.some((command) => command.includes("podman run"))).toBe(false)
	})
})

describe("checking the client runs", () => {
	it("runs the installed client in the pinned image by ID, with no network and no pull", () => {
		expect(clientCheckCommand(ARM64)).toBe(
			'podman run --rm --network=none --pull=never --user 0:0 --read-only --cap-drop=all -e DOTNET_BUNDLE_EXTRACT_BASE_DIR=/tmp -v "$HOME"/.local/share/open-mcc/bin:/opt/mcc:ro b54641a0139b45834e25e82fa2cf2be60bafa6a1b6a22868bb1df7182a27a7b9 /opt/mcc/MinecraftClient --help < /dev/null 2>&1',
		)
	})

	it("unpacks the client into the container's own temporary space, since its root is read-only", () => {
		expect(clientCheckCommand(ARM64)).toMatch(
			/--read-only .*-e DOTNET_BUNDLE_EXTRACT_BASE_DIR=\/tmp /,
		)
	})

	it("never runs the client on the host itself", async () => {
		const transport = await connected()

		await provisionHost(transport)

		expect(
			transport.commands.some((command) =>
				command.startsWith('"$HOME"/.local/share/open-mcc/bin/MinecraftClient'),
			),
		).toBe(false)
	})

	it("refuses to finish provisioning a host where the client cannot start", async () => {
		const transport = await connected({
			...ON_ARM64,
			[clientCheckCommand(ARM64)]: answer("Error: image not known", 125),
		})

		await expect(provisionHost(transport)).rejects.toThrow(/image not known/)
		expect(transport.commands.some((command) => command.includes("daemon-reload"))).toBe(false)
	})

	it("quotes what the client said when it could not start", () => {
		expect(explainClientFailure("Permission denied")).toContain("Permission denied")
	})

	it("says so plainly when the client fails silently", () => {
		expect(explainClientFailure("   \n  ")).toContain("reported nothing")
	})

	it("never tells the operator to install libicu, which ships in the image", () => {
		expect(
			explainClientFailure("Couldn't find a valid ICU package installed on the system."),
		).not.toContain("libicu")
	})
})

describe("where provisioning puts a host's files", () => {
	it("installs everything under the connecting account's home, owned by nobody else", async () => {
		const transport = await connected()

		await provisionHost(transport)

		expect(transport.commands.find((command) => command.startsWith("install -D"))).toMatch(
			/ "\$HOME"\/\.local\/share\/open-mcc\/bin\/MinecraftClient$/,
		)
		for (const command of transport.commands) {
			expect(command).not.toMatch(/chown| -o root|\/srv\/open-mcc|\/etc\/systemd\/system|sudo/)
		}
	})

	it("refuses a home that is not the account's own, before it writes anything", async () => {
		const transport = await connected({
			[SYSTEM_COMMAND]: answer(systemOutput({ home: "/srv/elsewhere" })),
		})

		await expect(provisionHost(transport)).rejects.toThrow(/account's own home/)
		expect(transport.commands).toEqual([SYSTEM_COMMAND])
	})

	it.each([
		["a leading space a login script added to HOME", { home: " /home/mcc" }],
		["a second line smuggled into HOME", { home: "/home/mcc /home/mcc" }],
		["trailing whitespace on the account's own home", { "passwd-home": "/home/mcc " }],
		["a shell metacharacter", { home: "/home/$(id -u)", "passwd-home": "/home/$(id -u)" }],
		["a relative path", { home: "home/mcc", "passwd-home": "home/mcc" }],
	])("refuses a home carrying %s, before it writes anything", async (_case, values) => {
		const transport = await connected({ [SYSTEM_COMMAND]: answer(systemOutput(values)) })

		await expect(provisionHost(transport)).rejects.toThrow(/account's own home/)
		expect(transport.commands).toEqual([SYSTEM_COMMAND])
	})

	it("reads a HOME carrying a newline as one value, so it cannot add a line of its own", () => {
		const ran = spawnSync("/bin/sh", ["-c", SYSTEM_COMMAND], {
			env: { HOME: "/home/mcc\nuid=0", PATH: process.env.PATH ?? "/usr/bin:/bin" },
		})

		const read = parseSystem(ran.stdout.toString())

		expect(read.home).toBe("/home/mcc uid=0")
		expect(read.uid).toBe(process.getuid?.())
	})

	it("refuses to go on without lingering, since every host runs its bots under a user manager", async () => {
		const transport = await connected({ [LINGER_COMMAND]: answer("no") })

		await expect(provisionHost(transport)).rejects.toThrow(/lingering is off/)
		expect(transport.commands.some((command) => command.includes("install -d"))).toBe(false)
		expect(transport.commands).not.toContain(HOST_FACTS_COMMAND)
	})
})

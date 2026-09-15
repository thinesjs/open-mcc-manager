import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { architectureForMachine } from "../../packages/core/src/host/mcc-release"
import {
	CLIENT_BANNER,
	clientCheckCommand,
	PROVISION_STEPS,
	provisionHost,
} from "../../packages/core/src/host/provision"
import { podmanImageId, runtimeImageFor } from "../../packages/core/src/host/runtime-image"
import { createFakeTransport } from "../../packages/transport/src/fake"
import {
	type As,
	buildImage,
	exec,
	ROOT,
	remove,
	SANDBOX_PLATFORM,
	shell,
	startHost,
	succeeded,
} from "./sandbox"

const TARGETS = [
	{ name: "Debian 12", baseImage: "debian:bookworm-20250908", stack: "slirp4netns" },
	{ name: "Debian 13", baseImage: "debian:trixie-20250908", stack: "pasta" },
	{ name: "Ubuntu 24.04", baseImage: "ubuntu:noble-20250910", stack: "slirp4netns" },
] as const

const ACCOUNT = "pod1"

const UID = 2001

const HOME = `/home/${ACCOUNT}`

const FILES = `${HOME}/.local/share/open-mcc`

const withUserManager = async (host: string): Promise<As> => {
	succeeded(await exec(host, ROOT, ["loginctl", "enable-linger", ACCOUNT]), "turning lingering on")
	succeeded(
		await shell(
			host,
			ROOT,
			'for attempt in $(seq 300); do [ "$(systemctl is-active "user@$1.service")" = active ] && [ -S "/run/user/$1/bus" ] && exit 0; sleep 0.1; done; exit 1',
			String(UID),
		),
		"waiting for the account's systemd",
	)
	return {
		user: ACCOUNT,
		workdir: HOME,
		env: {
			XDG_RUNTIME_DIR: `/run/user/${UID}`,
			DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${UID}/bus`,
		},
	}
}

const transportOn = async (host: string, as: As) => {
	const transport = createFakeTransport()
	await transport.connect({
		hostname: host,
		port: 22,
		username: as.user,
		privateKey: "",
		expectedFingerprint: "",
		timeoutMs: 1_000,
	})
	transport.exec = async (command: string, timeoutMs: number, stdin?: string) => {
		const ran = await shell(
			host,
			{ ...as, timeoutMs, ...(stdin === undefined ? {} : { input: stdin }) },
			command,
		)
		return { stdout: ran.stdout, stderr: ran.stderr, exitCode: ran.status ?? 255 }
	}
	return transport
}

describe.each(TARGETS)("provisioning a Podman host on $name", (target) => {
	let host = ""
	let as: As = ROOT

	beforeAll(async () => {
		const image = await buildImage({
			target: "podman-host",
			baseImage: target.baseImage,
			platform: SANDBOX_PLATFORM,
		})
		host = await startHost({ ...inject("sandbox"), image }, [
			`${HOME}/.local/share/containers:uid=${UID},gid=${UID},mode=0700`,
		])
		as = await withUserManager(host)
	}, 2_400_000)

	afterAll(async () => {
		await remove(host)
	}, 300_000)

	it("sets up a fresh account in fifteen steps, pulling the pinned image and running the client in it", async () => {
		const seen: string[] = []

		const result = await provisionHost(await transportOn(host, as), {
			onProgress: (progress) => seen.push(progress.step),
		})

		expect(seen).toEqual([...PROVISION_STEPS])
		expect(result.networkStack).toBe(target.stack)

		const verified = await exec(host, as, [
			"systemd-analyze",
			"--user",
			"verify",
			"open-mcc@probe.service",
			"open-mcc-auth@probe.service",
		])
		expect(verified.status, `${verified.stdout}${verified.stderr}`).toBe(0)

		const image = runtimeImageFor(
			architectureForMachine(succeeded(await exec(host, as, ["uname", "-m"]), "uname -m")),
		)
		expect(
			succeeded(
				await exec(host, as, [
					"podman",
					"image",
					"inspect",
					"--format",
					"{{.Id}} {{.Digest}}",
					podmanImageId(image),
				]),
				"inspecting the pulled image",
			).trim(),
		).toBe(`${podmanImageId(image)} ${image.manifest}`)

		const checked = await shell(host, { ...as, timeoutMs: 60_000 }, clientCheckCommand(image))
		expect(checked.stdout, checked.stderr).toContain(CLIENT_BANNER)

		expect(
			succeeded(await exec(host, as, ["podman", "ps", "--all", "--quiet"]), "listing containers"),
		).toBe("")
		expect(
			succeeded(
				await exec(host, ROOT, ["stat", "-c", "%a", FILES, `${FILES}/bin`, `${FILES}/instances`]),
				"reading the directory modes",
			)
				.trim()
				.split("\n"),
		).toEqual(["700", "700", "700"])
	}, 900_000)

	it("sets up the same account again, as Repair setup does", async () => {
		const result = await provisionHost(await transportOn(host, as))

		expect(result.networkStack).toBe(target.stack)
	}, 900_000)
})

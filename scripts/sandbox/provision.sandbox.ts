import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { architectureForMachine } from "../../packages/core/src/host/mcc-release"
import {
	CLIENT_BANNER,
	clientCheckCommand,
	PROVISION_STEPS,
	provisionHost,
} from "../../packages/core/src/host/provision"
import { podmanImageId, runtimeImageFor } from "../../packages/core/src/host/runtime-image"
import { instanceLayoutSteps } from "../../packages/core/src/instance/unit"
import {
	HOME,
	PODMAN_TARGETS,
	shellTransport,
	startPodmanHost,
	withUserManager,
} from "./podman-account"
import { type As, exec, ROOT, read, remove, shell, succeeded } from "./sandbox"

const FILES = `${HOME}/.local/share/open-mcc`

const JOURNAL_SOCKET = "/run/systemd/journal/socket"

describe.each(PODMAN_TARGETS)("provisioning a Podman host on $name", (target) => {
	let host = ""
	let as: As = ROOT

	beforeAll(async () => {
		host = await startPodmanHost(inject("sandbox"), target)
		as = await withUserManager(host)
	}, 2_400_000)

	afterAll(async () => {
		await remove(host)
	}, 300_000)

	it("sets up a fresh account in fifteen steps, pulling the pinned image and running the client in it", async () => {
		const seen: string[] = []

		const result = await provisionHost(shellTransport(host, as), {
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

		const probe = "/home/pod1/.local/share/open-mcc/instances/probe"
		for (const step of instanceLayoutSteps({
			instanceId: "probe",
			liveControlPort: 33333,
			liveControlToken: "0123456789abcdef0123456789abcdef",
			configDocument: "[Main]\n",
		})) {
			const ran = await shell(
				host,
				{ ...as, ...(step.stdin === undefined ? {} : { input: step.stdin }) },
				step.command,
			)
			expect(ran.status, `${step.failure}: ${ran.stderr}`).toBe(0)
		}
		expect(
			succeeded(
				await exec(host, ROOT, [
					"stat",
					"-c",
					"%n %a %F",
					probe,
					`${probe}/config`,
					`${probe}/state`,
					`${probe}/replays`,
					`${probe}/recording-cache`,
					`${probe}/control`,
					`${probe}/collect.lock`,
					`${probe}/unit.env`,
					`${probe}/env`,
					`${probe}/config/MinecraftClient.ini`,
				]),
				"reading the layout create makes",
			)
				.trim()
				.split("\n"),
		).toEqual([
			`${probe} 700 directory`,
			`${probe}/config 700 directory`,
			`${probe}/state 700 directory`,
			`${probe}/replays 700 directory`,
			`${probe}/recording-cache 700 directory`,
			`${probe}/control 600 fifo`,
			`${probe}/collect.lock 600 regular empty file`,
			`${probe}/unit.env 600 regular file`,
			`${probe}/env 600 regular file`,
			`${probe}/config/MinecraftClient.ini 600 regular file`,
		])
		expect(await read(host, `${probe}/unit.env`)).toBe("OPEN_MCC_PORT=33333\n")

		const image = runtimeImageFor(
			architectureForMachine(succeeded(await exec(host, as, ["uname", "-m"]), "uname -m")),
		)
		expect(
			succeeded(
				await shell(
					host,
					as,
					'podman image inspect --format "{{.Id}} {{.Digest}}" "$1"',
					podmanImageId(image),
				),
				"inspecting the pulled image",
			).trim(),
		).toBe(`${podmanImageId(image)} ${image.manifest}`)

		const checked = await shell(host, { ...as, timeoutMs: 60_000 }, clientCheckCommand(image))
		expect(checked.stdout, checked.stderr).toContain(CLIENT_BANNER)

		expect(succeeded(await shell(host, as, "podman ps --all --quiet"), "listing containers")).toBe(
			"",
		)
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
		const result = await provisionHost(shellTransport(host, as))

		expect(result.networkStack).toBe(target.stack)
	}, 900_000)

	it("runs the client on a host whose journal refuses this account, where a bot unit would run", async () => {
		const image = runtimeImageFor(
			architectureForMachine(succeeded(await exec(host, as, ["uname", "-m"]), "uname -m")),
		)
		const mode = succeeded(
			await exec(host, ROOT, ["stat", "-c", "%a", JOURNAL_SOCKET]),
			"reading the journal socket's mode",
		).trim()
		succeeded(
			await exec(host, ROOT, ["chmod", "0600", JOURNAL_SOCKET]),
			"closing the journal socket",
		)
		try {
			const checked = await shell(host, { ...as, timeoutMs: 60_000 }, clientCheckCommand(image))

			expect(checked.stdout, checked.stderr).toContain(CLIENT_BANNER)
			expect(checked.status, checked.stdout).toBe(0)
		} finally {
			succeeded(
				await exec(host, ROOT, ["chmod", mode, JOURNAL_SOCKET]),
				"reopening the journal socket",
			)
		}
	}, 300_000)
})

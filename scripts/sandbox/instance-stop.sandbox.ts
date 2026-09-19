import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { provisionHost } from "../../packages/core/src/host/provision"
import {
	INSTANCE_UNIT_NAME,
	QUIT_WRITE_TIMEOUT_SECONDS,
	renderUnitTemplates,
} from "../../packages/core/src/host/unit-template"
import { instanceLayoutSteps } from "../../packages/core/src/instance/unit"
import {
	HOME,
	PODMAN_TARGETS,
	shellTransport,
	startPodmanHost,
	withUserManager,
} from "./podman-account"
import { type As, exec, ROOT, remove, shell, succeeded } from "./sandbox"

type Instance = { id: string; dir: string }

const BIN = `${HOME}/.local/share/open-mcc/bin`

const INSTANCES = `${HOME}/.local/share/open-mcc/instances`

const BUSYBOX = "/opt/mcc/busybox"

const CLIENTS = {
	quitsCleanly: [
		`#!${BUSYBOX} sh`,
		"trap 'exit 143' TERM",
		": > started",
		"while IFS= read -r line; do",
		'\tif [ "$line" = /quit ]; then',
		`\t\t${BUSYBOX} sleep 2`,
		"\t\t: > logged-out",
		"\t\texit 0",
		"\tfi",
		"done",
		"",
	].join("\n"),
	ignoresQuit: `#!${BUSYBOX} sh\n: > started\nexec ${BUSYBOX} cat > /dev/null\n`,
	neverReads: `#!${BUSYBOX} sh\n: > started\nexec ${BUSYBOX} sleep 2147483647\n`,
	exitsByItself: `#!${BUSYBOX} sh\n: > started\nexit 0\n`,
} as const

type Client = keyof typeof CLIENTS

const WAIT_FOR_START =
	'for attempt in $(seq 300); do [ -e "$1/started" ] && exit 0; sleep 0.1; done; exit 1'

const FILL_CONTROL = 'timeout 2 sh -c \'cat /dev/zero > "$1"\' sh "$1" || [ $? -eq 124 ]'

const MANAGER = "systemctl --user"

const UNIT =
	renderUnitTemplates({
		networkStack: "slirp4netns",
		imageId: "b54641a0139b45834e25e82fa2cf2be60bafa6a1b6a22868bb1df7182a27a7b9",
	})[INSTANCE_UNIT_NAME] ?? ""

const unitSeconds = (setting: string): number =>
	Number(new RegExp(`^${setting}=(\\d+)$`, "m").exec(UNIT)?.[1])

const STOP_TIMEOUT_MS = unitSeconds("TimeoutStopSec") * 1000

const propertiesOf = (shown: string): ReadonlyMap<string, string> =>
	new Map(
		shown
			.split("\n")
			.filter((line) => line.includes("="))
			.map((line): [string, string] => [
				line.slice(0, line.indexOf("=")),
				line.slice(line.indexOf("=") + 1),
			]),
	)

describe("stopping a bot that runs in its own rootless Podman container on Debian 12", () => {
	let host = ""
	let as: As = ROOT

	beforeAll(async () => {
		host = await startPodmanHost(inject("sandbox"), PODMAN_TARGETS[0])
		as = await withUserManager(host)
		await provisionHost(shellTransport(host, as))
		succeeded(
			await shell(
				host,
				as,
				'cp "$(command -v busybox)" "$1/busybox" && chmod 0755 "$1/busybox"',
				BIN,
			),
			"installing busybox beside the client",
		)
	}, 2_400_000)

	afterAll(async () => {
		await remove(host)
	}, 300_000)

	const running = async (client: Client, port: number): Promise<Instance> => {
		succeeded(
			await shell(
				host,
				{ ...as, input: CLIENTS[client] },
				'cat > "$1/MinecraftClient.stand-in" && chmod 0755 "$1/MinecraftClient.stand-in" && mv -f "$1/MinecraftClient.stand-in" "$1/MinecraftClient"',
				BIN,
			),
			"installing a stand-in client",
		)
		const id = `t${randomUUID().slice(0, 8)}`
		for (const step of instanceLayoutSteps({
			instanceId: id,
			liveControlPort: port,
			liveControlToken: randomUUID().replaceAll("-", ""),
			configDocument: "[Main]\n",
		})) {
			succeeded(
				await shell(
					host,
					{ ...as, ...(step.stdin === undefined ? {} : { input: step.stdin }) },
					step.command,
				),
				step.failure,
			)
		}
		const dir = `${INSTANCES}/${id}`
		succeeded(
			await shell(host, as, `${MANAGER} start "$1"`, `open-mcc@${id}.service`),
			"starting the instance",
		)
		succeeded(
			await shell(host, as, WAIT_FOR_START, `${dir}/state`),
			"waiting for the stand-in client",
		)
		return { id, dir }
	}

	const stopped = async (instance: Instance): Promise<ReadonlyMap<string, string>> =>
		propertiesOf(
			succeeded(
				await shell(
					host,
					{ ...as, timeoutMs: 120_000 },
					[
						"before=$(date +%s%N)",
						`${MANAGER} stop "$1"`,
						"after=$(date +%s%N)",
						'echo "Elapsed=$(( (after - before) / 1000000 ))"',
						`${MANAGER} show -p Result -p ActiveState -p MainPID -p ExecMainStatus "$1"`,
					].join("\n"),
					`open-mcc@${instance.id}.service`,
				),
				"stopping the instance",
			),
		)

	const exists = async (path: string): Promise<boolean> =>
		(await exec(host, ROOT, ["test", "-e", path])).status === 0

	it("lets the client finish quitting, and records a clean stop inside the stop timeout", async () => {
		const instance = await running("quitsCleanly", 33341)

		const stop = await stopped(instance)

		expect(await exists(`${instance.dir}/state/logged-out`)).toBe(true)
		expect(stop.get("Result")).toBe("success")
		expect(stop.get("ExecMainStatus")).toBe("0")
		expect(Number(stop.get("Elapsed"))).toBeLessThan(STOP_TIMEOUT_MS)
	})

	it("still stops a client that ignores the quit, inside twice the stop timeout", async () => {
		const instance = await running("ignoresQuit", 33342)

		const stop = await stopped(instance)

		expect(Number(stop.get("Elapsed"))).toBeGreaterThanOrEqual(STOP_TIMEOUT_MS)
		expect(Number(stop.get("Elapsed"))).toBeLessThan(2 * STOP_TIMEOUT_MS)
		expect(stop.get("Result")).toBe("timeout")
		expect(stop.get("MainPID")).toBe("0")
	})

	it("stops a client that no longer reads its control channel in seconds, not at the timeout", async () => {
		const instance = await running("neverReads", 33343)
		succeeded(
			await shell(host, as, FILL_CONTROL, `${instance.dir}/control`),
			"filling the control channel",
		)

		const stop = await stopped(instance)

		expect(Number(stop.get("Elapsed"))).toBeLessThan(STOP_TIMEOUT_MS / 2)
		expect(stop.get("Result")).toBe("exit-code")
		expect(stop.get("MainPID")).toBe("0")
	})

	it("leaves a client that exited cleanly by itself stopped, and does not restart it", async () => {
		const instance = await running("exitsByItself", 33344)

		const unit = propertiesOf(
			succeeded(
				await shell(
					host,
					{ ...as, timeoutMs: 120_000 },
					`sleep "$2" && ${MANAGER} show -p Result -p ActiveState -p NRestarts "$1"`,
					`open-mcc@${instance.id}.service`,
					String(unitSeconds("RestartSec") + QUIT_WRITE_TIMEOUT_SECONDS + 10),
				),
				"reading the unit once a restart would have happened",
			),
		)

		expect(unit.get("Result")).toBe("success")
		expect(unit.get("NRestarts")).toBe("0")
		expect(unit.get("ActiveState")).toBe("inactive")
	})
})

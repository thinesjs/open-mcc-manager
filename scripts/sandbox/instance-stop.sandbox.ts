import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import {
	type HostProfile,
	rootlessProfile,
	systemProfile,
} from "../../packages/core/src/host/profile"
import {
	INSTANCE_UNIT_NAME,
	QUIT_WRITE_TIMEOUT_SECONDS,
	renderUnitTemplates,
} from "../../packages/core/src/host/unit-template"
import {
	type As,
	exec,
	homeOf,
	newAccount,
	ROOT,
	remove,
	shell,
	startHost,
	succeeded,
} from "./sandbox"

type Machine = { as: As; profile: HostProfile; manager: string }

type Instance = { id: string; dir: string }

const CLIENTS = {
	quitsCleanly: [
		"#!/bin/sh",
		"trap 'exit 143' TERM",
		": > started",
		"while IFS= read -r line; do",
		'\tif [ "$line" = /quit ]; then',
		"\t\tsleep 2",
		"\t\t: > logged-out",
		"\t\texit 0",
		"\tfi",
		"done",
		"",
	].join("\n"),
	ignoresQuit: "#!/bin/sh\n: > started\nexec cat > /dev/null\n",
	neverReads: "#!/bin/sh\n: > started\nexec sleep infinity\n",
	exitsByItself: "#!/bin/sh\n: > started\nexit 0\n",
} as const

type Client = keyof typeof CLIENTS

const PREPARE = {
	system: [
		'useradd -r -U -d "$1" -s /usr/sbin/nologin "$2"',
		'install -d -m 0700 -o "$2" -g "$2" "$1"',
		'mkfifo -m 0600 "$1/control"',
		'chown "$2:$2" "$1/control"',
		'(umask 077; : > "$1/env")',
		'chown "$2:$2" "$1/env"',
	].join(" && "),
	rootless: [
		'install -d -m 0700 "$1"',
		'mkfifo -m 0600 "$1/control"',
		'(umask 077; : > "$1/env")',
	].join(" && "),
} as const

const WAIT_FOR_START =
	'for attempt in $(seq 100); do [ -e "$1/started" ] && exit 0; sleep 0.1; done; exit 1'

const FILL_CONTROL = 'timeout 2 sh -c \'cat /dev/zero > "$1"\' sh "$1" || [ $? -eq 124 ]'

const unitOf = (profile: HostProfile): string =>
	renderUnitTemplates(profile)[INSTANCE_UNIT_NAME] ?? ""

const unitSeconds = (profile: HostProfile, setting: string): number =>
	Number(new RegExp(`^${setting}=(\\d+)$`, "m").exec(unitOf(profile))?.[1])

const stopTimeoutMs = (profile: HostProfile): number =>
	unitSeconds(profile, "TimeoutStopSec") * 1000

const machineFor = async (host: string, mode: HostProfile["mode"]): Promise<Machine> => {
	if (mode === "system") return { as: ROOT, profile: systemProfile(), manager: "systemctl" }
	const account = await newAccount(host)
	succeeded(await exec(host, ROOT, ["loginctl", "enable-linger", account]), "turning lingering on")
	const uid = succeeded(await exec(host, ROOT, ["id", "-u", account]), "reading a uid").trim()
	succeeded(
		await shell(
			host,
			ROOT,
			'for attempt in $(seq 200); do [ "$(systemctl is-active "user@$1.service")" = active ] && exit 0; sleep 0.1; done; exit 1',
			uid,
		),
		"waiting for the account's systemd",
	)
	return {
		as: { user: account, env: { XDG_RUNTIME_DIR: `/run/user/${uid}` } },
		profile: rootlessProfile(homeOf(account)),
		manager: "systemctl --user",
	}
}

const installUnit = async (host: string, machine: Machine): Promise<void> => {
	succeeded(
		await shell(
			host,
			{ ...machine.as, input: unitOf(machine.profile) },
			`mkdir -p "$1" && cat > "$1/$2" && ${machine.manager} daemon-reload`,
			machine.profile.unitDir,
			INSTANCE_UNIT_NAME,
		),
		"installing the rendered instance unit",
	)
}

const running = async (host: string, machine: Machine, client: Client): Promise<Instance> => {
	succeeded(
		await shell(
			host,
			{ ...machine.as, input: CLIENTS[client] },
			'mkdir -p "$1/bin" && cat > "$1/bin/MinecraftClient" && chmod 755 "$1/bin/MinecraftClient"',
			machine.profile.instancesRoot,
		),
		"installing a stand-in client",
	)
	const id = `t${randomUUID().slice(0, 8)}`
	const dir = `${machine.profile.instancesRoot}/instances/${id}`
	succeeded(
		await shell(host, machine.as, PREPARE[machine.profile.mode], dir, `mcc-${id}`),
		"preparing the instance directory",
	)
	succeeded(
		await shell(host, machine.as, `${machine.manager} enable --now "$1"`, `open-mcc@${id}.service`),
		"starting the instance",
	)
	succeeded(await shell(host, ROOT, WAIT_FOR_START, dir), "waiting for the stand-in client")
	return { id, dir }
}

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

const stopped = async (
	host: string,
	machine: Machine,
	instance: Instance,
): Promise<ReadonlyMap<string, string>> => {
	const shown = succeeded(
		await shell(
			host,
			machine.as,
			[
				"before=$(date +%s%N)",
				`${machine.manager} stop "$1"`,
				"after=$(date +%s%N)",
				'echo "Elapsed=$(( (after - before) / 1000000 ))"',
				`${machine.manager} show -p Result -p ActiveState -p MainPID -p ExecMainStatus "$1"`,
			].join("\n"),
			`open-mcc@${instance.id}.service`,
		),
		"stopping the instance",
	)
	return propertiesOf(shown)
}

const exists = async (host: string, path: string): Promise<boolean> =>
	(await exec(host, ROOT, ["test", "-e", path])).status === 0

describe.each([{ mode: "system" }, { mode: "rootless" }] as const)(
	"stopping an instance, in $mode mode",
	({ mode }) => {
		let host = ""
		let machine: Machine | undefined

		const ready = (): Machine => {
			if (machine === undefined) throw new Error("the sandbox host is not ready")
			return machine
		}

		beforeAll(async () => {
			host = await startHost(inject("sandbox"))
			machine = await machineFor(host, mode)
			await installUnit(host, machine)
		})

		afterAll(async () => {
			await remove(host)
		})

		it("lets the client finish quitting, and records a clean stop inside the stop timeout", async () => {
			const instance = await running(host, ready(), "quitsCleanly")

			const stop = await stopped(host, ready(), instance)

			expect(await exists(host, `${instance.dir}/logged-out`)).toBe(true)
			expect(stop.get("Result")).toBe("success")
			expect(stop.get("ExecMainStatus")).toBe("0")
			expect(Number(stop.get("Elapsed"))).toBeLessThan(stopTimeoutMs(ready().profile))
		})

		it("still stops a client that ignores the quit, once the stop timeout has passed", async () => {
			const instance = await running(host, ready(), "ignoresQuit")
			const limit = stopTimeoutMs(ready().profile)

			const stop = await stopped(host, ready(), instance)

			expect(Number(stop.get("Elapsed"))).toBeGreaterThanOrEqual(limit)
			expect(Number(stop.get("Elapsed"))).toBeLessThan(limit + 10_000)
			expect(stop.get("Result")).toBe("timeout")
			expect(stop.get("MainPID")).toBe("0")
		})

		it("stops a client that no longer reads its control channel in seconds, not at the timeout", async () => {
			const instance = await running(host, ready(), "neverReads")
			succeeded(
				await shell(host, ready().as, FILL_CONTROL, `${instance.dir}/control`),
				"filling the control channel",
			)

			const stop = await stopped(host, ready(), instance)

			expect(Number(stop.get("Elapsed"))).toBeLessThan(stopTimeoutMs(ready().profile) / 2)
			expect(stop.get("Result")).toBe("exit-code")
			expect(stop.get("MainPID")).toBe("0")
		})

		it("leaves a client that exited cleanly by itself stopped, and does not restart it", async () => {
			const instance = await running(host, ready(), "exitsByItself")

			const unit = propertiesOf(
				succeeded(
					await shell(
						host,
						ready().as,
						`sleep "$2" && ${ready().manager} show -p Result -p ActiveState -p NRestarts "$1"`,
						`open-mcc@${instance.id}.service`,
						String(unitSeconds(ready().profile, "RestartSec") + QUIT_WRITE_TIMEOUT_SECONDS + 10),
					),
					"reading the unit once a restart would have happened",
				),
			)

			expect(unit.get("Result")).toBe("success")
			expect(unit.get("NRestarts")).toBe("0")
			expect(unit.get("ActiveState")).toBe("inactive")
		})
	},
)

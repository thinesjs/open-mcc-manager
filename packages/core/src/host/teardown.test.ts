import { createFakeTransport, type FakeScript } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { UNIT_STOP_TIMEOUT_MS } from "../instance/removal"
import { podmanImageId, runtimeImageFor } from "./runtime-image"
import { tearDownHost } from "./teardown"

const LIST_UNITS = 'ls -1 "$HOME"/.config/systemd/user 2>/dev/null || true'

const INSTANCES_LEFT = 'test -e "$HOME"/.local/share/open-mcc && printf present || printf gone'

const LINGER = 'loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || printf no'

const LIST_CONTAINERS = "XDG_RUNTIME_DIR=/run/user/$(id -u) podman ps -a --format '{{.Names}}'"

const RUNNING_UNITS =
	"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user list-units --plain --no-legend --state=active,activating,deactivating,reloading 'open-mcc*'"

const STOP_BOTS =
	"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop 'open-mcc@*.service' 'open-mcc-auth@*.service'"

const REMOVE_FILES = `timeout -k 5 50 sh -c 'chmod -R u+rwX -- "$HOME"/.local/share/open-mcc && rm -rf -- "$HOME"/.local/share/open-mcc'; s=$?; exit $s`

const INSTALLED_UNITS = "open-mcc@.service\nopen-mcc-auth@.service\nsshd.service\n"

const answer = (stdout: string, exitCode = 0) => ({ stdout, stderr: "", exitCode })

const hostHolding = async (containers: readonly string[], script: FakeScript = {}) => {
	const transport = createFakeTransport({ [INSTANCES_LEFT]: answer("gone"), ...script })
	await transport.connect({
		hostname: "h",
		port: 22,
		username: "u",
		privateKey: "k",
		expectedFingerprint: "f",
		timeoutMs: 1000,
	})
	let present = [...containers]
	let unitsInstalled = true
	const scripted = transport.exec
	transport.exec = async (command: string, timeoutMs: number, stdin?: string) => {
		const result = await scripted(command, timeoutMs, stdin)
		if (script[command] !== undefined) return result
		if (command === LIST_UNITS) return answer(unitsInstalled ? INSTALLED_UNITS : "sshd.service\n")
		if (command === LIST_CONTAINERS) return answer(present.map((name) => `${name}\n`).join(""))
		if (command.includes("podman rm -f")) present = []
		if (command.startsWith("rm -f ")) unitsInstalled = false
		return result
	}
	return transport
}

const waitFor = (transport: Awaited<ReturnType<typeof hostHolding>>, command: string) =>
	transport.timeouts[transport.commands.indexOf(command)]

describe("cleaning a host when it is removed", () => {
	it("removes only the units this control plane installed, and reports a clean host as clean", async () => {
		const transport = await hostHolding(["open-mcc-abc"])

		const report = await tearDownHost(transport, "x64")

		expect(report.unitsRemoved).toEqual(["open-mcc@.service", "open-mcc-auth@.service"])
		expect(transport.commands.some((command) => command.includes("sshd.service"))).toBe(false)
		expect(report.remaining).toEqual([])
	})

	it("stops each unit through the user manager before deleting its file, so nothing keeps running headless", async () => {
		const transport = await hostHolding([])

		await tearDownHost(transport, "x64")

		const stopAt = transport.commands.findIndex((c) => c.includes("systemctl --user disable --now"))
		const removeAt = transport.commands.findIndex((c) => c.startsWith("rm -f"))
		expect(stopAt).toBeGreaterThanOrEqual(0)
		expect(stopAt).toBeLessThan(removeAt)
	})

	it("stops every bot and sign-in the manager started, giving them as long as a unit needs to stop", async () => {
		const transport = await hostHolding(["open-mcc-abc"])

		await tearDownHost(transport, "x64")

		const stopAt = transport.commands.indexOf(STOP_BOTS)
		expect(stopAt).toBeGreaterThanOrEqual(0)
		expect(waitFor(transport, STOP_BOTS)).toBe(UNIT_STOP_TIMEOUT_MS)
		expect(stopAt).toBeLessThan(transport.commands.findIndex((c) => c.includes("podman rm -f")))
	})

	it("removes every container the manager named, and no other, in one exec under a host deadline", async () => {
		const transport = await hostHolding(["open-mcc-abc", "open-mcc-auth-abc", "someone-else"])

		await tearDownHost(transport, "x64")

		const removal =
			"timeout -k 5 50 podman rm -f --ignore open-mcc-abc open-mcc-auth-abc; s=$?; exit $s"
		expect(transport.commands.filter((c) => c.includes("podman rm -f"))).toEqual([removal])
		expect(waitFor(transport, removal)).toBe(60_000)
	})

	it.each(["x64", "arm64"] as const)(
		"removes the pinned runtime image for a %s host under a host deadline",
		async (architecture) => {
			const transport = await hostHolding([])

			await tearDownHost(transport, architecture)

			const removal = `timeout -k 3 10 podman rmi --ignore ${podmanImageId(runtimeImageFor(architecture))}; s=$?; exit $s`
			expect(transport.commands.filter((c) => c.includes("podman rmi"))).toEqual([removal])
			expect(waitFor(transport, removal)).toBe(15_000)
		},
	)

	it("leaves the image alone on a host that never recorded its architecture", async () => {
		const transport = await hostHolding([])

		await tearDownHost(transport, undefined)

		expect(transport.commands.filter((c) => c.includes("podman rmi"))).toEqual([])
	})

	it("removes the instances directory under a host deadline, first making anything a bot locked removable", async () => {
		const transport = await hostHolding([])

		await tearDownHost(transport, "x64")

		expect(transport.commands).toContain(REMOVE_FILES)
		expect(waitFor(transport, REMOVE_FILES)).toBe(60_000)
	})

	it("runs every destructive command under a host deadline that ends inside its wait", async () => {
		const transport = await hostHolding(["open-mcc-abc"])

		await tearDownHost(transport, "arm64")

		const destructive = transport.commands
			.map((command, index) => ({ command, waitMs: transport.timeouts[index] ?? 0 }))
			.filter(({ command }) => /podman rmi? |rm -rf/.test(command))
		expect(destructive).toHaveLength(3)
		for (const { command, waitMs } of destructive) {
			const found = /^timeout -k (\d+) (\d+) .*; s=\$\?; exit \$s$/.exec(command)
			expect(found, command).not.toBeNull()
			expect((Number(found?.[1]) + Number(found?.[2])) * 1000).toBeLessThan(waitMs)
		}
	})

	it("sends no pkill or pgrep, since a containerised client's command line never names the host's path", async () => {
		const transport = await hostHolding(["open-mcc-abc"])

		await tearDownHost(transport, "x64")

		expect(transport.commands.filter((command) => /pkill|pgrep/.test(command))).toEqual([])
	})

	it("never deletes an account, since every bot runs as the one it connects as", async () => {
		const transport = await hostHolding([])

		await tearDownHost(transport, "x64")

		expect(transport.commands.some((command) => /userdel|groupdel/.test(command))).toBe(false)
	})

	it("reports what it could not clean rather than claiming success", async () => {
		const transport = await hostHolding([], { [INSTANCES_LEFT]: answer("present") })

		const report = await tearDownHost(transport, "x64")

		expect(report.directoryRemoved).toBe(false)
		expect(report.remaining.join(" ")).toContain(".local/share/open-mcc")
	})

	it.each([
		{
			named: "a container survives its removal",
			script: { [LIST_CONTAINERS]: answer("open-mcc-abc\n") },
			reported: "1 container(s) still present",
		},
		{
			named: "the containers cannot be listed",
			script: { [LIST_CONTAINERS]: answer("", 125) },
			reported: "The containers could not be listed",
		},
		{
			named: "a bot's unit is still running",
			script: { [RUNNING_UNITS]: answer("open-mcc@abc.service loaded active running bot\n") },
			reported: "1 unit(s) still running",
		},
		{
			named: "the running units cannot be listed",
			script: { [RUNNING_UNITS]: answer("", 1) },
			reported: "The running units could not be listed",
		},
		{
			named: "the runtime image cannot be removed",
			script: {
				[`timeout -k 3 10 podman rmi --ignore ${podmanImageId(runtimeImageFor("x64"))}; s=$?; exit $s`]:
					answer("", 2),
			},
			reported: "The runtime image could not be removed",
		},
	])("reports it when $named", async ({ script, reported }) => {
		const transport = await hostHolding([], script)

		const report = await tearDownHost(transport, "x64")

		expect(report.remaining).toEqual([reported])
	})

	it("says lingering is still enabled, since removing it needs root the manager does not have", async () => {
		const transport = await hostHolding([], { [LINGER]: answer("yes") })

		const report = await tearDownHost(transport, "x64")

		expect(report.lingeringLeft).toBe(true)
	})
})

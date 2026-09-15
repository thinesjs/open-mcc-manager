import type { HostCheckReport } from "@open-mcc/contracts"
import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import {
	CLIENT_PROBE_COMMAND,
	checkHostOverTransport,
	FORWARD_PROBE_PORT,
	LINGER_COMMAND,
	PODMAN_INSTALL_COMMAND,
	ROOT_REFUSAL,
	unreachableReport,
} from "./check"
import { HOST_FACTS_COMMAND, PODMAN_INFO_COMMAND } from "./podman-facts"

const ACCOUNT = "mcc"

const FRESH_FACTS = {
	uid: "1001",
	home: "/home/mcc",
	"passwd-home": "/home/mcc",
	os: "debian 12",
	podman: "podman version 4.3.1",
	storage: "fresh",
	cgroup: "cgroup2fs",
	metadata: "000",
}

type Facts = Record<string, string>

const factsOutput = (facts: Facts, extra: readonly string[] = []): string =>
	[...Object.entries(facts).map(([key, value]) => `${key}=${value}`), ...extra].join("\n")

const OWN_RANGES = ["subuid=own 165536 65536", "subgid=own 165536 65536", "helper=slirp4netns"]

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 })

const hostWith = (
	facts: Facts = FRESH_FACTS,
	extra: readonly string[] = OWN_RANGES,
	overrides: Record<string, { stdout: string; stderr: string; exitCode: number }> = {},
) => ({
	"systemctl --version | head -n 1": ok("systemd 252 (252.39-1~deb12u2)"),
	"uname -m": ok("aarch64"),
	[CLIENT_PROBE_COMMAND]: ok("3"),
	[LINGER_COMMAND]: ok("yes"),
	[HOST_FACTS_COMMAND]: ok(factsOutput(facts, extra)),
	...overrides,
})

const connected = async (
	responses: Record<string, { stdout: string; stderr: string; exitCode: number }>,
	forwarding = true,
) => {
	const transport = createFakeTransport(responses, {}, forwarding, [FORWARD_PROBE_PORT])
	await transport.connect({
		hostname: "h",
		port: 22,
		username: ACCOUNT,
		privateKey: "k",
		expectedFingerprint: "f",
		timeoutMs: 1000,
	})
	return transport
}

const check = async (
	responses: Record<string, { stdout: string; stderr: string; exitCode: number }>,
	forwarding = true,
) => checkHostOverTransport(await connected(responses, forwarding), ACCOUNT)

const resultOf = (report: HostCheckReport, name: string) =>
	report.checks.find((each) => each.name === name)

const outcomeOf = (report: HostCheckReport, name: string) => resultOf(report, name)?.outcome

describe("checking a host before committing to enrol it", () => {
	it("passes a fresh host that is ready, and warns only that storage is set up later", async () => {
		const report = await check(hostWith())

		expect(report.ready).toBe(true)
		expect(
			report.checks.filter((each) => each.outcome !== "pass").map((each) => each.name),
		).toEqual(["storage"])
		expect(resultOf(report, "storage")).toMatchObject({
			outcome: "warn",
			detail: "Set up during provisioning.",
		})
	})

	it("reports the checks in the order the contract names them", async () => {
		const report = await check(hostWith())

		expect(report.checks.map((each) => each.name)).toEqual([
			"reachable",
			"account",
			"systemd",
			"architecture",
			"lingering",
			"podman",
			"cgroups",
			"subordinate-ids",
			"network-helper",
			"storage",
			"tcp-forwarding",
			"cloud-metadata",
			"client-runtime",
		])
	})

	it("reads the Podman facts in one command", async () => {
		const transport = await connected(hostWith())

		await checkHostOverTransport(transport, ACCOUNT)

		expect(transport.commands.filter((each) => each === HOST_FACTS_COMMAND)).toHaveLength(1)
	})

	it("checks lingering on every host, since every host runs its bots under a user manager", async () => {
		const transport = await connected(hostWith())

		const report = await checkHostOverTransport(transport, ACCOUNT)

		expect(transport.commands).toContain(LINGER_COMMAND)
		expect(outcomeOf(report, "lingering")).toBe("pass")
	})

	it("blocks on lingering, and gives the command that turns it on", async () => {
		const report = await check(hostWith(FRESH_FACTS, OWN_RANGES, { [LINGER_COMMAND]: ok("no") }))

		expect(report.ready).toBe(false)
		expect(resultOf(report, "lingering")).toMatchObject({
			outcome: "fail",
			detail: "Bots would stop when you log out.",
			command: "sudo loginctl enable-linger mcc",
		})
	})

	it("reports nothing about confinement, and runs no probe for it", async () => {
		const transport = await connected(hostWith())

		const report = await checkHostOverTransport(transport, ACCOUNT)

		expect(report.checks.map((each) => each.name)).not.toContain("confinement")
		expect(transport.commands.some((command) => command.includes("systemd-run"))).toBe(false)
	})

	it("blocks on a missing client dependency and names the package", async () => {
		const report = await check(
			hostWith(FRESH_FACTS, OWN_RANGES, { [CLIENT_PROBE_COMMAND]: ok("0") }),
		)

		expect(report.ready).toBe(false)
		expect(resultOf(report, "client-runtime")?.detail).toContain("libicu")
	})

	it("blocks on an architecture with no client build", async () => {
		const report = await check(hostWith(FRESH_FACTS, OWN_RANGES, { "uname -m": ok("armv7l") }))

		expect(report.ready).toBe(false)
		expect(outcomeOf(report, "architecture")).toBe("fail")
	})

	it("★ shows our own Unknown rather than a systemd line it cannot trust", async () => {
		const report = await check(
			hostWith(FRESH_FACTS, OWN_RANGES, {
				"systemctl --version | head -n 1": ok(
					`systemd 255 \u001b]8;;https://203.0.113.9:8443\u0007${"x".repeat(200)}`,
				),
			}),
		)

		expect(resultOf(report, "systemd")?.detail).toBe("Unknown")
	})

	it("★ withholds a machine name it cannot read when the architecture has no build", async () => {
		const report = await check(
			hostWith(FRESH_FACTS, OWN_RANGES, { "uname -m": ok("\u001b[2Jriscv64 203.0.113.9:2222") }),
		)
		const detail = resultOf(report, "architecture")?.detail ?? ""

		expect(detail).not.toContain("203.0.113.9")
		expect(detail).toContain("'Unknown'")
	})

	it("blocks on a home folder that is not the account's own", async () => {
		const report = await check(hostWith({ ...FRESH_FACTS, home: "/srv/elsewhere" }))

		expect(resultOf(report, "systemd")).toMatchObject({
			outcome: "fail",
			detail: "This account's home folder can't be used.",
		})
	})

	it("reports every check as unchecked when the host cannot be reached at all", () => {
		const report = unreachableReport("All configured authentication methods failed")

		expect(report.ready).toBe(false)
		expect(outcomeOf(report, "reachable")).toBe("fail")
		expect(report.checks.filter((each) => each.outcome === "skipped")).toHaveLength(12)
	})
})

describe("refusing to run bots as root", () => {
	it("fails the account check for uid 0, with the plain sentence", async () => {
		const report = await check(hostWith({ ...FRESH_FACTS, uid: "0", storage: "used" }))

		expect(report.ready).toBe(false)
		expect(resultOf(report, "account")).toMatchObject({
			outcome: "fail",
			detail: "Bots can't run as root. Use a normal account.",
			command: null,
		})
		expect(ROOT_REFUSAL).toBe("Bots can't run as root. Use a normal account.")
	})

	it("fails the account check when Podman does not report rootless", async () => {
		const report = await check(
			hostWith({ ...FRESH_FACTS, storage: "used" }, OWN_RANGES, {
				[PODMAN_INFO_COMMAND]: ok("false overlay"),
			}),
		)

		expect(report.ready).toBe(false)
		expect(resultOf(report, "account")).toMatchObject({ outcome: "fail", detail: ROOT_REFUSAL })
	})

	it("leaves the rootless flag to setup on a fresh account", async () => {
		const report = await check(hostWith())

		expect(resultOf(report, "account")).toMatchObject({ outcome: "pass" })
		expect(resultOf(report, "account")?.detail).toContain("checked during setup")
	})
})

describe("never starting Podman on an account that has not run it", () => {
	it("issues no podman info on a fresh account", async () => {
		const transport = await connected(hostWith())

		await checkHostOverTransport(transport, ACCOUNT)

		expect(transport.commands.some((each) => each.includes("podman info"))).toBe(false)
	})

	it("reads the rootless flag and the driver on an account that already ran Podman", async () => {
		const transport = await connected(
			hostWith({ ...FRESH_FACTS, storage: "used" }, OWN_RANGES, {
				[PODMAN_INFO_COMMAND]: ok("true overlay"),
			}),
		)

		const report = await checkHostOverTransport(transport, ACCOUNT)

		expect(transport.commands).toContain(PODMAN_INFO_COMMAND)
		expect(outcomeOf(report, "storage")).toBe("pass")
		expect(outcomeOf(report, "account")).toBe("pass")
	})
})

describe("container storage", () => {
	it("fails an account whose Podman already has data in another driver", async () => {
		const report = await check(
			hostWith({ ...FRESH_FACTS, storage: "used" }, OWN_RANGES, {
				[PODMAN_INFO_COMMAND]: ok("true vfs"),
			}),
		)

		expect(report.ready).toBe(false)
		expect(resultOf(report, "storage")).toMatchObject({
			outcome: "fail",
			detail: "Podman on this account already has data. Use a fresh account.",
		})
	})

	it.each([
		{ override: "XDG_CONFIG_HOME" },
		{ override: "XDG_DATA_HOME" },
		{ override: "CONTAINERS_STORAGE_CONF" },
		{ override: "rootless_storage_path" },
	])("fails a refused setting, $override, without starting Podman", async ({ override }) => {
		const transport = await connected(
			hostWith({ ...FRESH_FACTS, storage: "used" }, [...OWN_RANGES, `override=${override}`], {
				[PODMAN_INFO_COMMAND]: ok("true overlay"),
			}),
		)

		const report = await checkHostOverTransport(transport, ACCOUNT)

		expect(resultOf(report, "storage")).toMatchObject({
			outcome: "fail",
			detail: "This account's Podman storage settings aren't supported.",
		})
		expect(resultOf(report, "storage")?.hint).toContain(override)
		expect(transport.commands.some((each) => each.includes("podman info"))).toBe(false)
	})

	it("passes an account whose storage.conf is already the manager's", async () => {
		const report = await check(
			hostWith({ ...FRESH_FACTS, storage: "set-up" }, OWN_RANGES, {
				[PODMAN_INFO_COMMAND]: ok("true overlay"),
			}),
		)

		expect(outcomeOf(report, "storage")).toBe("pass")
	})

	it("passes an account the manager already set up when podman info fails, leaving Podman's error to provisioning", async () => {
		const report = await check(
			hostWith({ ...FRESH_FACTS, storage: "set-up" }, OWN_RANGES, {
				[PODMAN_INFO_COMMAND]: {
					stdout: "",
					stderr: "Error: command required for rootless mode with multiple IDs",
					exitCode: 125,
				},
			}),
		)

		expect(resultOf(report, "storage")).toMatchObject({ outcome: "pass", detail: "Set up" })
		expect(report.ready).toBe(true)
	})

	it("still fails an account the manager set up when Podman reports another driver", async () => {
		const report = await check(
			hostWith({ ...FRESH_FACTS, storage: "set-up" }, OWN_RANGES, {
				[PODMAN_INFO_COMMAND]: ok("true vfs"),
			}),
		)

		expect(resultOf(report, "storage")).toMatchObject({
			outcome: "fail",
			detail: "Podman on this account already has data. Use a fresh account.",
		})
	})

	it("still fails an account that already ran Podman when podman info fails", async () => {
		const report = await check(
			hostWith({ ...FRESH_FACTS, storage: "used" }, OWN_RANGES, {
				[PODMAN_INFO_COMMAND]: { stdout: "", stderr: "Error: database graph driver", exitCode: 125 },
			}),
		)

		expect(resultOf(report, "storage")).toMatchObject({
			outcome: "fail",
			detail: "Podman on this account already has data. Use a fresh account.",
		})
	})
})

describe("Podman itself", () => {
	it("gives the install command, with --no-remove, when Podman is missing", async () => {
		const report = await check(hostWith({ ...FRESH_FACTS, podman: "" }))

		expect(report.ready).toBe(false)
		expect(resultOf(report, "podman")).toMatchObject({
			outcome: "fail",
			detail: "Podman isn't installed.",
			command: PODMAN_INSTALL_COMMAND,
		})
		expect(PODMAN_INSTALL_COMMAND).toBe(
			"sudo apt-get install -y --no-install-recommends --no-remove podman uidmap slirp4netns catatonit dbus-user-session",
		)
		expect(outcomeOf(report, "network-helper")).toBe("skipped")
	})

	it("names the version it found when Podman is too old", async () => {
		const report = await check(hostWith({ ...FRESH_FACTS, podman: "podman version 3.4.4" }))

		expect(resultOf(report, "podman")).toMatchObject({
			outcome: "fail",
			detail: "Needs Podman 4.3.1 or newer. This server has 3.4.4.",
			command: null,
		})
	})

	it("says Ubuntu 24.04 is untested on a real Ubuntu host", async () => {
		const report = await check(
			hostWith({ ...FRESH_FACTS, os: "ubuntu 24.04", podman: "podman version 4.9.3" }),
		)

		expect(outcomeOf(report, "podman")).toBe("pass")
		expect(resultOf(report, "podman")?.hint).toContain("untested on a real Ubuntu host")
	})

	it("says nothing about Ubuntu on Debian", async () => {
		const report = await check(hostWith())

		expect(resultOf(report, "podman")?.hint ?? "").not.toContain("Ubuntu")
	})

	it("fails a host without cgroup v2", async () => {
		const report = await check(hostWith({ ...FRESH_FACTS, cgroup: "tmpfs" }))

		expect(resultOf(report, "cgroups")).toMatchObject({
			outcome: "fail",
			detail: "This server's system is too old for Podman.",
			hint: "Podman needs cgroup v2.",
		})
	})
})

describe("what an account needs to run containers", () => {
	it("gives the usermod command with a range after the highest one in use", async () => {
		const report = await check(
			hostWith(FRESH_FACTS, [
				"subuid=other 100000 65536",
				"subgid=other 100000 65536",
				"subgid=other 165536 65536",
				"helper=slirp4netns",
			]),
		)

		expect(report.ready).toBe(false)
		expect(resultOf(report, "subordinate-ids")).toMatchObject({
			outcome: "fail",
			detail: "This account can't run containers yet.",
			command: "sudo usermod --add-subuids 231072-296607 --add-subgids 231072-296607 mcc",
		})
	})

	it("fails when only one of the two files has the account", async () => {
		const report = await check(
			hostWith(FRESH_FACTS, ["subuid=own 165536 65536", "helper=slirp4netns"]),
		)

		expect(outcomeOf(report, "subordinate-ids")).toBe("fail")
	})

	it.each([
		{ podman: "podman version 4.3.1", helper: "pasta", missing: "slirp4netns" },
		{ podman: "podman version 5.4.2", helper: "slirp4netns", missing: "passt" },
	])("asks for $missing when $podman has only $helper", async ({ podman, helper, missing }) => {
		const report = await check(
			hostWith({ ...FRESH_FACTS, podman }, [
				"subuid=own 165536 65536",
				"subgid=own 165536 65536",
				`helper=${helper}`,
			]),
		)

		expect(resultOf(report, "network-helper")).toMatchObject({
			outcome: "fail",
			detail: "A Podman network helper is missing.",
			command: `sudo apt-get install -y --no-install-recommends --no-remove ${missing}`,
		})
	})

	it("quotes an account name the shell would otherwise split", async () => {
		const transport = await connected(
			hostWith(FRESH_FACTS, OWN_RANGES, { [LINGER_COMMAND]: ok("no") }),
		)

		const report = await checkHostOverTransport(transport, "bot runner")

		expect(resultOf(report, "lingering")?.command).toBe("sudo loginctl enable-linger 'bot runner'")
	})
})

describe("a cloud metadata service the bots could reach", () => {
	it("warns rather than blocks when one answers", async () => {
		const report = await check(hostWith({ ...FRESH_FACTS, metadata: "401" }))

		expect(report.ready).toBe(true)
		expect(resultOf(report, "cloud-metadata")).toMatchObject({
			outcome: "warn",
			detail: "Bots on this server can reach its cloud metadata service.",
			hint: "Don't give this server cloud roles or credentials.",
		})
	})

	it("reports it as not checked when curl is missing", async () => {
		const report = await check(hostWith({ ...FRESH_FACTS, metadata: "none" }))

		expect(resultOf(report, "cloud-metadata")).toMatchObject({
			outcome: "skipped",
			detail: "Not checked",
		})
	})
})

describe("checking that live control can reach an instance", () => {
	it("passes when the host permits forwarding through the existing connection", async () => {
		const report = await check(hostWith())

		expect(outcomeOf(report, "tcp-forwarding")).toBe("pass")
	})

	it("warns rather than blocks when forwarding is refused, since instances still run", async () => {
		const report = await check(hostWith(), false)

		expect(outcomeOf(report, "tcp-forwarding")).toBe("warn")
		expect(report.ready).toBe(true)
	})

	it("names the sshd setting an operator has to change", async () => {
		const report = await check(hostWith(), false)

		expect(resultOf(report, "tcp-forwarding")?.detail).toContain("AllowTcpForwarding")
	})

	it("reports it as unchecked when the host could not be reached at all", () => {
		expect(
			unreachableReport("nope").checks.find((each) => each.name === "tcp-forwarding")?.outcome,
		).toBe("skipped")
	})
})

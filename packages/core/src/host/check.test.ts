import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import {
	CLIENT_PROBE_COMMAND,
	checkHostOverTransport,
	FORWARD_PROBE_PORT,
	LINGER_COMMAND,
	unreachableReport,
} from "./check"

const READY = {
	"systemctl --version | head -n 1": { stdout: "systemd 255", stderr: "", exitCode: 0 },
	"uname -m": { stdout: "x86_64", stderr: "", exitCode: 0 },
	[CLIENT_PROBE_COMMAND]: { stdout: "3", stderr: "", exitCode: 0 },
	[LINGER_COMMAND]: { stdout: "yes", stderr: "", exitCode: 0 },
}

const connected = async (
	responses: Record<string, { stdout: string; stderr: string; exitCode: number }>,
	forwarding = true,
) => {
	const transport = createFakeTransport(responses, {}, forwarding, [FORWARD_PROBE_PORT])
	await transport.connect({
		hostname: "h",
		port: 22,
		username: "u",
		privateKey: "k",
		expectedFingerprint: "f",
		timeoutMs: 1000,
	})
	return transport
}

const outcomeOf = (report: Awaited<ReturnType<typeof checkHostOverTransport>>, name: string) =>
	report.checks.find((check) => check.name === name)?.outcome

describe("checking a host before committing to enrol it", () => {
	it("passes a host that is ready, and says so", async () => {
		const report = await checkHostOverTransport(await connected(READY))

		expect(report.ready).toBe(true)
		expect(report.checks.every((check) => check.outcome !== "fail")).toBe(true)
	})

	it("checks lingering on every host, since every host runs its bots under a user manager", async () => {
		const transport = await connected(READY)

		const report = await checkHostOverTransport(transport)

		expect(transport.commands).toContain(LINGER_COMMAND)
		expect(outcomeOf(report, "lingering")).toBe("pass")
	})

	it("blocks on lingering, which would otherwise fail only during provisioning", async () => {
		const report = await checkHostOverTransport(
			await connected({ ...READY, [LINGER_COMMAND]: { stdout: "no", stderr: "", exitCode: 0 } }),
		)

		expect(report.ready).toBe(false)
		expect(outcomeOf(report, "lingering")).toBe("fail")
	})

	it("reports nothing about confinement, and runs no probe for it", async () => {
		const transport = await connected(READY)

		const report = await checkHostOverTransport(transport)

		expect(report.checks.map((check) => check.name)).not.toContain("confinement")
		expect(transport.commands.some((command) => command.includes("systemd-run"))).toBe(false)
	})

	it("blocks on a missing client dependency and names the package", async () => {
		const report = await checkHostOverTransport(
			await connected({
				...READY,
				[CLIENT_PROBE_COMMAND]: { stdout: "0", stderr: "", exitCode: 0 },
			}),
		)

		expect(report.ready).toBe(false)
		expect(report.checks.find((check) => check.name === "client-runtime")?.detail).toContain(
			"libicu",
		)
	})

	it("blocks on an architecture with no client build", async () => {
		const report = await checkHostOverTransport(
			await connected({ ...READY, "uname -m": { stdout: "armv7l", stderr: "", exitCode: 0 } }),
		)

		expect(report.ready).toBe(false)
		expect(outcomeOf(report, "architecture")).toBe("fail")
	})

	it("★ shows our own Unknown rather than a systemd line it cannot trust", async () => {
		const report = await checkHostOverTransport(
			await connected({
				...READY,
				"systemctl --version | head -n 1": {
					stdout: `systemd 255 \u001b]8;;https://203.0.113.9:8443\u0007${"x".repeat(200)}`,
					stderr: "",
					exitCode: 0,
				},
			}),
		)

		expect(report.checks.find((check) => check.name === "systemd")?.detail).toBe("Unknown")
	})

	it("★ withholds a machine name it cannot read when the architecture has no build", async () => {
		const report = await checkHostOverTransport(
			await connected({
				...READY,
				"uname -m": { stdout: "\u001b[2Jriscv64 203.0.113.9:2222", stderr: "", exitCode: 0 },
			}),
		)
		const detail = report.checks.find((check) => check.name === "architecture")?.detail ?? ""

		expect(detail).not.toContain("203.0.113.9")
		expect(detail).toContain("'Unknown'")
	})

	it("reports every check as unchecked when the host cannot be reached at all", () => {
		const report = unreachableReport("All configured authentication methods failed")

		expect(report.ready).toBe(false)
		expect(outcomeOf(report, "reachable")).toBe("fail")
		expect(report.checks.filter((check) => check.outcome === "skipped")).toHaveLength(5)
	})
})

describe("checking that live control can reach an instance", () => {
	it("passes when the host permits forwarding through the existing connection", async () => {
		const report = await checkHostOverTransport(await connected(READY))

		expect(outcomeOf(report, "tcp-forwarding")).toBe("pass")
	})

	it("warns rather than blocks when forwarding is refused, since instances still run", async () => {
		const report = await checkHostOverTransport(await connected(READY, false))

		expect(outcomeOf(report, "tcp-forwarding")).toBe("warn")
		expect(report.ready).toBe(true)
	})

	it("names the sshd setting an operator has to change", async () => {
		const report = await checkHostOverTransport(await connected(READY, false))

		expect(report.checks.find((check) => check.name === "tcp-forwarding")?.detail).toContain(
			"AllowTcpForwarding",
		)
	})

	it("reports it as unchecked when the host could not be reached at all", () => {
		expect(
			unreachableReport("nope").checks.find((check) => check.name === "tcp-forwarding")?.outcome,
		).toBe("skipped")
	})
})

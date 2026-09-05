import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import {
	CLIENT_PROBE_COMMAND,
	checkHostOverTransport,
	LINGER_COMMAND,
	unreachableReport,
} from "./check"
import { sandboxProbeCommand } from "./facts"

const READY = {
	"systemctl --version | head -n 1": { stdout: "systemd 255", stderr: "", exitCode: 0 },
	"uname -m": { stdout: "x86_64", stderr: "", exitCode: 0 },
	[CLIENT_PROBE_COMMAND]: { stdout: "3", stderr: "", exitCode: 0 },
	[LINGER_COMMAND]: { stdout: "yes", stderr: "", exitCode: 0 },
	[sandboxProbeCommand()]: { stdout: "enforced", stderr: "", exitCode: 0 },
}

const connected = async (
	responses: Record<string, { stdout: string; stderr: string; exitCode: number }>,
) => {
	const transport = createFakeTransport(responses)
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
		const report = await checkHostOverTransport(await connected(READY), "rootless")

		expect(report.ready).toBe(true)
		expect(report.checks.every((check) => check.outcome !== "fail")).toBe(true)
	})

	it("blocks on lingering, which would otherwise fail only during provisioning", async () => {
		const report = await checkHostOverTransport(
			await connected({ ...READY, [LINGER_COMMAND]: { stdout: "no", stderr: "", exitCode: 0 } }),
			"rootless",
		)

		expect(report.ready).toBe(false)
		expect(outcomeOf(report, "lingering")).toBe("fail")
	})

	it("blocks on a missing client dependency and names the package", async () => {
		const report = await checkHostOverTransport(
			await connected({
				...READY,
				[CLIENT_PROBE_COMMAND]: { stdout: "0", stderr: "", exitCode: 0 },
			}),
			"rootless",
		)

		expect(report.ready).toBe(false)
		expect(report.checks.find((check) => check.name === "client-runtime")?.detail).toContain(
			"libicu",
		)
	})

	it("blocks on an architecture with no client build", async () => {
		const report = await checkHostOverTransport(
			await connected({ ...READY, "uname -m": { stdout: "armv7l", stderr: "", exitCode: 0 } }),
			"rootless",
		)

		expect(report.ready).toBe(false)
		expect(outcomeOf(report, "architecture")).toBe("fail")
	})

	it("warns rather than blocks when confinement will not be enforced, since instances still run", async () => {
		const report = await checkHostOverTransport(
			await connected({
				...READY,
				[sandboxProbeCommand()]: { stdout: "ignored", stderr: "", exitCode: 0 },
			}),
			"rootless",
		)

		expect(report.ready).toBe(true)
		expect(outcomeOf(report, "confinement")).toBe("warn")
	})

	it("does not ask a root-owned host about lingering, which it does not use", async () => {
		const report = await checkHostOverTransport(await connected(READY), "system")

		expect(outcomeOf(report, "lingering")).toBe("skipped")
		expect(outcomeOf(report, "confinement")).toBe("skipped")
	})

	it("reports every check as unchecked when the host cannot be reached at all", () => {
		const report = unreachableReport("All configured authentication methods failed")

		expect(report.ready).toBe(false)
		expect(outcomeOf(report, "reachable")).toBe("fail")
		expect(report.checks.filter((check) => check.outcome === "skipped")).toHaveLength(5)
	})
})

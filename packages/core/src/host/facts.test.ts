import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import {
	hostFact,
	parseCount,
	parseMemoryMb,
	parseOsRelease,
	readHostFacts,
	readsAsEnforced,
	sandboxProbeCommand,
} from "./facts"
import { systemProfile } from "./profile"

describe("recognising which distribution a host runs", () => {
	it("reads the identifier and the human name from the host's own os-release", () => {
		expect(parseOsRelease("debian\nDebian GNU/Linux 12 (bookworm)")).toEqual({
			osId: "debian",
			osName: "Debian GNU/Linux 12 (bookworm)",
		})
	})

	it("reports nothing rather than guessing when the host has no os-release", () => {
		expect(parseOsRelease("\n")).toEqual({ osId: null, osName: null })
	})

	it("strips the quotes some distributions write around their values", () => {
		expect(parseOsRelease('"ubuntu"\n"Ubuntu 24.04.1 LTS"').osId).toBe("ubuntu")
	})

	it("refuses an absurdly long value rather than storing whatever the host sent", () => {
		expect(parseOsRelease(`${"x".repeat(200)}\nname`).osId).toBe("Unknown")
	})
})

describe("reading a host's size", () => {
	it("reads a processor count", () => {
		expect(parseCount("4")).toBe(4)
	})

	it("reports nothing rather than zero when the host could not answer", () => {
		expect(parseCount("0")).toBe(null)
		expect(parseCount("")).toBe(null)
	})

	it("converts the kilobytes /proc/meminfo reports into megabytes", () => {
		expect(parseMemoryMb("16777216")).toBe(16384)
	})
})

describe("checking whether instances are actually confined", () => {
	it("runs the probe as one command, not as arguments to the cleanup", () => {
		const command = sandboxProbeCommand("/tmp/marker")

		expect(command).toMatch(/rm -f '\/tmp\/marker';\s*systemd-run/)
	})

	it("asks the user manager, since that is the manager a rootless instance runs under", () => {
		expect(sandboxProbeCommand()).toContain("systemd-run --user")
	})

	it("treats a leaked file as sandboxing that was silently ignored", () => {
		expect(readsAsEnforced("ignored")).toBe(false)
		expect(readsAsEnforced("enforced")).toBe(true)
		expect(readsAsEnforced("")).toBe(false)
	})
})

describe("★ a fact the host reports about itself", () => {
	it.each([
		["a terminal escape", "Debian \u001b[31mGNU/Linux\u001b[0m 12"],
		["a line longer than any release name", "x".repeat(129)],
		["characters outside plain printable text", "Ubuntu 24.04 \u202e LTS"],
	])("shows our own Unknown for %s", (_label, value) => {
		expect(hostFact(value)).toBe("Unknown")
		expect(parseOsRelease(`debian\n${value}`).osName).toBe("Unknown")
	})

	it("keeps an ordinary release line exactly, and reports nothing for no answer", () => {
		expect(hostFact("systemd 252 (252.22-1~deb12u1)\n")).toBe("systemd 252 (252.22-1~deb12u1)")
		expect(hostFact(" \n")).toBeNull()
	})

	it("reads the systemd line through the same rule when it checks on a host", async () => {
		const transport = createFakeTransport({
			"systemctl --version | head -n 1": {
				stdout: "systemd 252 \u001b[31m203.0.113.9:2222",
				stderr: "",
				exitCode: 0,
			},
		})
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "root",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1000,
		})

		expect((await readHostFacts(transport, systemProfile())).osRelease).toBe("Unknown")
	})
})

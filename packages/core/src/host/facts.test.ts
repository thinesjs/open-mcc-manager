import { describe, expect, it } from "vitest"
import {
	parseCount,
	parseMemoryMb,
	parseOsRelease,
	readsAsEnforced,
	sandboxProbeCommand,
} from "./facts"

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
		expect(parseOsRelease(`${"x".repeat(200)}\nname`).osId).toBe(null)
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

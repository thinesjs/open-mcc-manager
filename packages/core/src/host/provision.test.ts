import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import {
	explainClientFailure,
	PROVISION_STEPS,
	parseOsRelease,
	provisionHost,
	readsAsEnforced,
	sandboxProbeCommand,
	validateInstancesRoot,
} from "./provision"

const CLIENT_PROBE_OK = {
	"'/srv/open-mcc/bin/MinecraftClient' --help < /dev/null 2>&1": {
		stdout: "Minecraft Console Client v26.2",
		stderr: "",
		exitCode: 0,
	},
}

describe("validateInstancesRoot", () => {
	it("rejects a relative path and a path with a space", () => {
		expect(() => validateInstancesRoot("srv/open-mcc")).toThrow()
		expect(() => validateInstancesRoot("/srv/open mcc")).toThrow()
	})

	it("accepts an absolute path", () => {
		expect(validateInstancesRoot("/srv/open-mcc")).toBe("/srv/open-mcc")
	})
})

describe("provisionHost", () => {
	it("never asks the host about docker, which it no longer needs", async () => {
		const transport = createFakeTransport(CLIENT_PROBE_OK)
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "root",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1000,
		})

		const result = await provisionHost(transport, { mode: "system" })

		expect(transport.commands.some((command) => command.startsWith("docker"))).toBe(false)
		expect(result.osRelease).toEqual(expect.any(String))
	})

	it("never installs a client whose checksum did not match", async () => {
		const transport = createFakeTransport(CLIENT_PROBE_OK)
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "root",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1000,
		})
		const original = transport.exec
		transport.exec = async (command: string, timeoutMs: number, stdin?: string) =>
			command.includes("sha256sum")
				? { stdout: "", stderr: "FAILED", exitCode: 1 }
				: await original(command, timeoutMs, stdin)

		await expect(provisionHost(transport, { mode: "system" })).rejects.toThrow(/checksum/i)
		expect(transport.commands.some((command) => command.includes("install -D"))).toBe(false)
	})

	it("removes the downloaded file even when the checksum rejects it", async () => {
		const transport = createFakeTransport(CLIENT_PROBE_OK)
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "root",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1000,
		})
		const original = transport.exec
		transport.exec = async (command: string, timeoutMs: number, stdin?: string) =>
			command.includes("sha256sum")
				? { stdout: "", stderr: "FAILED", exitCode: 1 }
				: await original(command, timeoutMs, stdin)

		await expect(provisionHost(transport, { mode: "system" })).rejects.toThrow()
		expect(transport.commands.some((command) => command.startsWith("rm -rf"))).toBe(true)
	})

	it("downloads into a private temporary directory rather than a guessable path", async () => {
		const transport = createFakeTransport(CLIENT_PROBE_OK)
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "root",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1000,
		})

		await provisionHost(transport, { mode: "system" })

		const download = transport.commands.find((command) => command.includes("curl"))
		expect(download).toContain("mktemp -d")
		expect(transport.commands.some((command) => command.includes("/tmp/mcc-download"))).toBe(false)
	})

	it("verifies before it installs, as two steps an operator can tell apart", async () => {
		const transport = createFakeTransport(CLIENT_PROBE_OK)
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "root",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1000,
		})

		await provisionHost(transport, { mode: "system" })

		const verifyAt = transport.commands.findIndex((command) => command.includes("sha256sum"))
		const installAt = transport.commands.findIndex((command) => command.includes("install -D"))
		expect(verifyAt).toBeGreaterThanOrEqual(0)
		expect(installAt).toBeGreaterThan(verifyAt)
	})

	it("reports every step it is about to take, in order", async () => {
		const transport = createFakeTransport(CLIENT_PROBE_OK)
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "root",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1000,
		})

		const seen: string[] = []
		await provisionHost(transport, {
			mode: "system",
			onProgress: (progress) => seen.push(progress.step),
		})

		expect(seen).toEqual([...PROVISION_STEPS])
	})

	it("installs the build matching the host's own architecture, not a fixed one", async () => {
		const transport = createFakeTransport({
			...CLIENT_PROBE_OK,
			"uname -m": { stdout: "aarch64\n", stderr: "", exitCode: 0 },
		})
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "root",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1000,
		})

		await provisionHost(transport, { mode: "system" })

		const download = transport.commands.find((command) => command.includes("curl"))
		if (download === undefined) throw new Error("no download step was issued")
		expect(download).toContain("linux-arm64")
		expect(download).not.toContain("linux-x64")
	})

	it("refuses to provision a host whose architecture has no published build", async () => {
		const transport = createFakeTransport({
			...CLIENT_PROBE_OK,
			"uname -m": { stdout: "riscv64", stderr: "", exitCode: 0 },
		})
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "root",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1000,
		})

		await expect(provisionHost(transport, { mode: "system" })).rejects.toThrow(/riscv64/)
		expect(transport.commands.some((command) => command.includes("curl"))).toBe(false)
	})

	it("delivers the unit template as stdin rather than a concatenated heredoc", async () => {
		const transport = createFakeTransport(CLIENT_PROBE_OK)
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "root",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1000,
		})

		await provisionHost(transport, { mode: "system" })

		const command = transport.commands.find((each) => each.includes("open-mcc@.service"))
		expect(command).toBe("cat > '/etc/systemd/system/open-mcc@.service'")
		expect(transport.stdins.some((each) => each.includes("RestartPreventExitStatus=4"))).toBe(true)
		expect(transport.commands).toContain("systemctl daemon-reload")
	})
})

describe("checking the client can actually run", () => {
	it("names the missing library when the runtime cannot start, rather than reporting a bare failure", () => {
		const message = explainClientFailure(
			"Process terminated.\nCouldn't find a valid ICU package installed on the system.",
		)

		expect(message).toContain("libicu")
		expect(message).toContain("provision again")
	})

	it("quotes what the client said when the failure is something else", () => {
		expect(explainClientFailure("Permission denied")).toContain("Permission denied")
	})

	it("says so plainly when the client fails silently", () => {
		expect(explainClientFailure("   \n  ")).toContain("reported nothing")
	})

	it("refuses to finish provisioning a host where the client cannot start", async () => {
		const transport = createFakeTransport({
			"systemctl --version | head -n 1": { stdout: "systemd 252", stderr: "", exitCode: 0 },
			"uname -m": { stdout: "x86_64", stderr: "", exitCode: 0 },
			"'/srv/open-mcc/bin/MinecraftClient' --help < /dev/null 2>&1": {
				stdout: "Couldn't find a valid ICU package installed on the system.",
				stderr: "",
				exitCode: 134,
			},
		})
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "u",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1000,
		})

		await expect(provisionHost(transport, { mode: "system" })).rejects.toThrow(/libicu/)
		expect(transport.commands.some((command) => command.includes("daemon-reload"))).toBe(false)
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

	it("reports a host whose systemd drops the hardening, rather than assuming it took", async () => {
		const transport = createFakeTransport({
			...CLIENT_PROBE_OK,
			"systemctl --version | head -n 1": { stdout: "systemd 252", stderr: "", exitCode: 0 },
			'printf %s "$HOME"': { stdout: "/home/mccuser", stderr: "", exitCode: 0 },
			'loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || printf no': {
				stdout: "yes",
				stderr: "",
				exitCode: 0,
			},
			"'/home/mccuser/.local/share/open-mcc/bin/MinecraftClient' --help < /dev/null 2>&1": {
				stdout: "Minecraft Console Client v26.2",
				stderr: "",
				exitCode: 0,
			},
			[sandboxProbeCommand()]: { stdout: "ignored", stderr: "", exitCode: 0 },
		})
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "u",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1000,
		})

		const result = await provisionHost(transport, { mode: "rootless" })

		expect(result.sandboxed).toBe(false)
	})

	it("does not probe a root-owned host, whose system manager always enforces it", async () => {
		const transport = createFakeTransport(CLIENT_PROBE_OK)
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "u",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1000,
		})

		const result = await provisionHost(transport, { mode: "system" })

		expect(result.sandboxed).toBe(true)
		expect(transport.commands.some((command) => command.includes("systemd-run"))).toBe(false)
	})
})

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

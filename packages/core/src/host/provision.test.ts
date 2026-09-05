import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { PROVISION_STEPS, provisionHost, validateInstancesRoot } from "./provision"

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
		const transport = createFakeTransport()
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
		const transport = createFakeTransport({})
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
		const transport = createFakeTransport({})
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
		const transport = createFakeTransport({})
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
		const transport = createFakeTransport({})
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
		const transport = createFakeTransport({})
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
		const transport = createFakeTransport()
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

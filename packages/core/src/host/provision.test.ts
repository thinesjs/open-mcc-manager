import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import {
	assertInstancesRootMatchesUnitTemplate,
	provisionHost,
	validateInstancesRoot,
} from "./provision"

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

		const result = await provisionHost(transport, { instancesRoot: "/srv/open-mcc" })

		expect(transport.commands.some((command) => command.startsWith("docker"))).toBe(false)
		expect(result.osRelease).toEqual(expect.any(String))
	})

	it("aborts before installing when the downloaded client fails its checksum", async () => {
		const transport = createFakeTransport({}, {})
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
				? { stdout: "", stderr: "/tmp/mcc-download: FAILED", exitCode: 1 }
				: await original(command, timeoutMs, stdin)

		await expect(provisionHost(transport, { instancesRoot: "/srv/open-mcc" })).rejects.toThrow(
			/checksum/i,
		)
		expect(transport.commands.some((command) => command.includes("install -D"))).toBe(false)
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

		await provisionHost(transport, { instancesRoot: "/srv/open-mcc" })

		const command = transport.commands.find((each) => each.includes("open-mcc@.service"))
		expect(command).toBe("cat > '/etc/systemd/system/open-mcc@.service'")
		expect(transport.stdins.some((each) => each.includes("RestartPreventExitStatus=4"))).toBe(true)
		expect(transport.commands).toContain("systemctl daemon-reload")
	})
})

describe("assertInstancesRootMatchesUnitTemplate", () => {
	it("refuses a root the static unit template cannot reference", () => {
		expect(() => assertInstancesRootMatchesUnitTemplate("/opt/elsewhere")).toThrow(
			/deliberately static/,
		)
	})

	it("accepts the root the template is fixed at", () => {
		expect(assertInstancesRootMatchesUnitTemplate("/srv/open-mcc")).toBe("/srv/open-mcc")
	})
})

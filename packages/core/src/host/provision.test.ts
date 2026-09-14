import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { LINGER_COMMAND } from "./check"
import { explainClientFailure, HOME_COMMAND, PROVISION_STEPS, provisionHost } from "./provision"

type Script = Record<string, { stdout: string; stderr: string; exitCode: number }>

const answer = (stdout: string, exitCode = 0) => ({ stdout, stderr: "", exitCode })

const CLIENT_PROBE = '"$HOME"/.local/share/open-mcc/bin/MinecraftClient --help < /dev/null 2>&1'

const PROVISIONABLE: Script = {
	[HOME_COMMAND]: answer("/home/mcc\n/home/mcc"),
	[LINGER_COMMAND]: answer("yes"),
	[CLIENT_PROBE]: answer("Minecraft Console Client v26.2"),
}

const connected = async (script: Script = PROVISIONABLE) => {
	const transport = createFakeTransport(script)
	await transport.connect({
		hostname: "h",
		port: 22,
		username: "mcc",
		privateKey: "k",
		expectedFingerprint: "f",
		timeoutMs: 1000,
	})
	return transport
}

const refusingChecksum = async () => {
	const transport = await connected()
	const original = transport.exec
	transport.exec = async (command: string, timeoutMs: number, stdin?: string) =>
		command.includes("sha256sum")
			? { stdout: "", stderr: "FAILED", exitCode: 1 }
			: await original(command, timeoutMs, stdin)
	return transport
}

describe("provisionHost", () => {
	it("never asks the host about docker, which it no longer needs", async () => {
		const transport = await connected()

		const result = await provisionHost(transport)

		expect(transport.commands.some((command) => command.startsWith("docker"))).toBe(false)
		expect(result.osRelease).toEqual(expect.any(String))
	})

	it("never installs a client whose checksum did not match", async () => {
		const transport = await refusingChecksum()

		await expect(provisionHost(transport)).rejects.toThrow(/checksum/i)
		expect(transport.commands.some((command) => command.includes("install -D"))).toBe(false)
	})

	it("removes the downloaded file even when the checksum rejects it", async () => {
		const transport = await refusingChecksum()

		await expect(provisionHost(transport)).rejects.toThrow()
		expect(transport.commands.some((command) => command.startsWith("rm -rf"))).toBe(true)
	})

	it("downloads into a private temporary directory rather than a guessable path", async () => {
		const transport = await connected()

		await provisionHost(transport)

		const download = transport.commands.find((command) => command.includes("curl"))
		expect(download).toContain("mktemp -d")
		expect(transport.commands.some((command) => command.includes("/tmp/mcc-download"))).toBe(false)
	})

	it("verifies before it installs, as two steps an operator can tell apart", async () => {
		const transport = await connected()

		await provisionHost(transport)

		const verifyAt = transport.commands.findIndex((command) => command.includes("sha256sum"))
		const installAt = transport.commands.findIndex((command) => command.includes("install -D"))
		expect(verifyAt).toBeGreaterThanOrEqual(0)
		expect(installAt).toBeGreaterThan(verifyAt)
	})

	it("★ records our own Unknown for a systemd line it cannot trust", async () => {
		const transport = await connected({
			...PROVISIONABLE,
			"systemctl --version | head -n 1": answer(`systemd 252 \u001b[31m${"x".repeat(200)}`),
		})

		expect((await provisionHost(transport)).osRelease).toBe("Unknown")
	})

	it("reports every step it is about to take, in order", async () => {
		const transport = await connected()

		const seen: string[] = []
		await provisionHost(transport, { onProgress: (progress) => seen.push(progress.step) })

		expect(seen).toEqual([...PROVISION_STEPS])
	})

	it("installs the build matching the host's own architecture, not a fixed one", async () => {
		const transport = await connected({ ...PROVISIONABLE, "uname -m": answer("aarch64\n") })

		await provisionHost(transport)

		const download = transport.commands.find((command) => command.includes("curl"))
		if (download === undefined) throw new Error("no download step was issued")
		expect(download).toContain("linux-arm64")
		expect(download).not.toContain("linux-x64")
	})

	it("refuses to provision a host whose architecture has no published build", async () => {
		const transport = await connected({ ...PROVISIONABLE, "uname -m": answer("riscv64") })

		await expect(provisionHost(transport)).rejects.toThrow(/riscv64/)
		expect(transport.commands.some((command) => command.includes("curl"))).toBe(false)
	})

	it("delivers the unit template as stdin into the user manager's own directory", async () => {
		const transport = await connected()

		await provisionHost(transport)

		const command = transport.commands.find((each) => each.includes("open-mcc@.service"))
		expect(command).toBe(
			`mkdir -p "$HOME"/.config/systemd/user && cat > "$HOME"/.config/systemd/user/'open-mcc@.service'`,
		)
		expect(transport.stdins.some((each) => each.includes("RestartPreventExitStatus=4"))).toBe(true)
		expect(transport.commands).toContain(
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user daemon-reload",
		)
	})
})

describe("where provisioning puts a host's files", () => {
	it("installs everything under the connecting account's home, owned by nobody else", async () => {
		const transport = await connected()

		await provisionHost(transport)

		expect(transport.commands).toContain(
			'install -d -m 0711 "$HOME"/.local/share/open-mcc/instances',
		)
		expect(transport.commands.find((command) => command.startsWith("install -D"))).toMatch(
			/ "\$HOME"\/\.local\/share\/open-mcc\/bin\/MinecraftClient$/,
		)
		for (const command of transport.commands) {
			expect(command).not.toMatch(/chown| -o root|\/srv\/open-mcc|\/etc\/systemd\/system/)
		}
	})

	it("refuses a home that is not the account's own, before it writes anything", async () => {
		const transport = await connected({
			...PROVISIONABLE,
			[HOME_COMMAND]: answer("/srv/elsewhere\n/home/mcc"),
		})

		await expect(provisionHost(transport)).rejects.toThrow(/account's own home/)
		expect(transport.commands.some((command) => command.includes("install -d"))).toBe(false)
		expect(transport.commands.some((command) => command.includes("curl"))).toBe(false)
	})

	it("refuses to go on without lingering, since every host runs its bots under a user manager", async () => {
		const transport = await connected({ ...PROVISIONABLE, [LINGER_COMMAND]: answer("no") })

		await expect(provisionHost(transport)).rejects.toThrow(/lingering is off/)
		expect(transport.commands.some((command) => command.includes("install -d"))).toBe(false)
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
		const transport = await connected({
			...PROVISIONABLE,
			"systemctl --version | head -n 1": answer("systemd 252"),
			[CLIENT_PROBE]: answer("Couldn't find a valid ICU package installed on the system.", 134),
		})

		await expect(provisionHost(transport)).rejects.toThrow(/libicu/)
		expect(transport.commands.some((command) => command.includes("daemon-reload"))).toBe(false)
	})
})

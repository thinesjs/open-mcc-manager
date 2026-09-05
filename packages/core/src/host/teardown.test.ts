import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { rootlessProfile, systemProfile } from "./profile"
import { isSafeToRemove, PROTECTED_PATHS, selfExcludingPattern, tearDownHost } from "./teardown"

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

const CLEAN = {
	"ls -1 '/etc/systemd/system' 2>/dev/null || true": {
		stdout: "open-mcc@.service\nopen-mcc-auth@.service\nsshd.service\n",
		stderr: "",
		exitCode: 0,
	},
	"test -e '/srv/open-mcc' && printf present || printf gone": {
		stdout: "gone",
		stderr: "",
		exitCode: 0,
	},
}

describe("refusing to delete a path that is not ours", () => {
	it("refuses every well-known system directory", () => {
		for (const path of PROTECTED_PATHS) {
			expect(isSafeToRemove(path)).toBe(false)
		}
	})

	it("refuses a path shallow enough to be a system directory", () => {
		expect(isSafeToRemove("/opt")).toBe(false)
		expect(isSafeToRemove("/anything")).toBe(false)
	})

	it("refuses anything that could climb out with a parent segment", () => {
		expect(isSafeToRemove("/srv/open-mcc/../../etc")).toBe(false)
	})

	it("refuses a relative path, which would delete from an unknown directory", () => {
		expect(isSafeToRemove("srv/open-mcc")).toBe(false)
	})

	it("accepts the roots this control plane actually installs into", () => {
		expect(isSafeToRemove("/srv/open-mcc")).toBe(true)
		expect(isSafeToRemove("/home/pi/.local/share/open-mcc")).toBe(true)
		expect(isSafeToRemove("/srv/open-mcc/")).toBe(true)
	})
})

describe("cleaning a host when it is removed", () => {
	it("removes only the units this control plane installed", async () => {
		const transport = await connected(CLEAN)

		const report = await tearDownHost(transport, systemProfile(), [])

		expect(report.unitsRemoved).toEqual(["open-mcc@.service", "open-mcc-auth@.service"])
		expect(transport.commands.some((command) => command.includes("sshd.service"))).toBe(false)
	})

	it("stops each unit before deleting its file, so nothing keeps running headless", async () => {
		const transport = await connected(CLEAN)

		await tearDownHost(transport, systemProfile(), [])

		const stopAt = transport.commands.findIndex((c) => c.includes("disable --now"))
		const removeAt = transport.commands.findIndex((c) => c.startsWith("rm -f"))
		expect(stopAt).toBeGreaterThanOrEqual(0)
		expect(stopAt).toBeLessThan(removeAt)
	})

	it("kills anything still running from the instances directory", async () => {
		const transport = await connected(CLEAN)

		await tearDownHost(transport, systemProfile(), [])

		expect(transport.commands.some((c) => c.startsWith("pkill -f '/srv/[o]pen-mcc'"))).toBe(true)
	})

	it("removes the per-instance accounts on a host that has them", async () => {
		const transport = await connected(CLEAN)

		const report = await tearDownHost(transport, systemProfile(), ["abc", "def"])

		expect(report.accountsRemoved).toEqual(["mcc-abc", "mcc-def"])
	})

	it("does not try to remove accounts on a host that never created any", async () => {
		const transport = await connected({
			"ls -1 '/home/pi/.config/systemd/user' 2>/dev/null || true": {
				stdout: "",
				stderr: "",
				exitCode: 0,
			},
			"test -e '/home/pi/.local/share/open-mcc' && printf present || printf gone": {
				stdout: "gone",
				stderr: "",
				exitCode: 0,
			},
		})

		const report = await tearDownHost(transport, rootlessProfile("/home/pi"), ["abc"])

		expect(report.accountsRemoved).toEqual([])
		expect(transport.commands.some((c) => c.includes("userdel"))).toBe(false)
	})

	it("reports what it could not clean rather than claiming success", async () => {
		const transport = await connected({
			...CLEAN,
			"test -e '/srv/open-mcc' && printf present || printf gone": {
				stdout: "present",
				stderr: "",
				exitCode: 0,
			},
		})

		const report = await tearDownHost(transport, systemProfile(), [])

		expect(report.directoryRemoved).toBe(false)
		expect(report.remaining.join(" ")).toContain("/srv/open-mcc")
	})

	it("says lingering is still enabled, since removing it needs root the manager does not have", async () => {
		const transport = await connected({
			"ls -1 '/home/pi/.config/systemd/user' 2>/dev/null || true": {
				stdout: "",
				stderr: "",
				exitCode: 0,
			},
			"test -e '/home/pi/.local/share/open-mcc' && printf present || printf gone": {
				stdout: "gone",
				stderr: "",
				exitCode: 0,
			},
			'loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || printf no': {
				stdout: "yes",
				stderr: "",
				exitCode: 0,
			},
		})

		const report = await tearDownHost(transport, rootlessProfile("/home/pi"), [])

		expect(report.lingeringLeft).toBe(true)
	})
})

describe("sweeping leftover processes without killing the sweep itself", () => {
	it("hides the pattern from its own command line, which pkill would otherwise match", () => {
		expect(selfExcludingPattern("/srv/open-mcc")).toBe("/srv/[o]pen-mcc")
		expect(selfExcludingPattern("/home/pi/.local/share/open-mcc")).toBe(
			"/home/pi/.local/share/[o]pen-mcc",
		)
	})

	it("still matches the real path, since the class matches its own first character", () => {
		const pattern = selfExcludingPattern("/srv/open-mcc")

		expect(new RegExp(pattern).test("/srv/open-mcc/bin/MinecraftClient")).toBe(true)
	})

	it("does not match the command that carries the pattern, which is the whole point", () => {
		const pattern = selfExcludingPattern("/srv/open-mcc")

		expect(new RegExp(pattern).test(`pkill -f ${pattern}`)).toBe(false)
	})

	it("tolerates a trailing slash rather than producing an empty class", () => {
		expect(selfExcludingPattern("/srv/open-mcc/")).toBe("/srv/[o]pen-mcc")
	})

	it("uses the guarded pattern in the commands it runs", async () => {
		const transport = await connected(CLEAN)

		await tearDownHost(transport, systemProfile(), [])

		expect(transport.commands.some((c) => c.includes("[o]pen-mcc"))).toBe(true)
		expect(transport.commands.some((c) => c.startsWith("pkill -f '/srv/open-mcc'"))).toBe(false)
	})
})

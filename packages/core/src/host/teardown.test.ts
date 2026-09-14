import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { selfExcludingPattern, tearDownHost } from "./teardown"

const LIST_UNITS = 'ls -1 "$HOME"/.config/systemd/user 2>/dev/null || true'

const INSTANCES_LEFT = 'test -e "$HOME"/.local/share/open-mcc && printf present || printf gone'

const LINGER = 'loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || printf no'

const answer = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 })

const CLEAN = {
	[LIST_UNITS]: answer("open-mcc@.service\nopen-mcc-auth@.service\nsshd.service\n"),
	[INSTANCES_LEFT]: answer("gone"),
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

describe("cleaning a host when it is removed", () => {
	it("removes only the units this control plane installed", async () => {
		const transport = await connected(CLEAN)

		const report = await tearDownHost(transport)

		expect(report.unitsRemoved).toEqual(["open-mcc@.service", "open-mcc-auth@.service"])
		expect(transport.commands.some((command) => command.includes("sshd.service"))).toBe(false)
	})

	it("stops each unit through the user manager before deleting its file, so nothing keeps running headless", async () => {
		const transport = await connected(CLEAN)

		await tearDownHost(transport)

		const stopAt = transport.commands.findIndex((c) => c.includes("systemctl --user disable --now"))
		const removeAt = transport.commands.findIndex((c) => c.startsWith("rm -f"))
		expect(stopAt).toBeGreaterThanOrEqual(0)
		expect(stopAt).toBeLessThan(removeAt)
	})

	it("removes the instances directory under the account's own home", async () => {
		const transport = await connected(CLEAN)

		await tearDownHost(transport)

		expect(transport.commands).toContain('rm -rf "$HOME"/.local/share/open-mcc')
	})

	it("kills anything still running from the instances directory", async () => {
		const transport = await connected(CLEAN)

		await tearDownHost(transport)

		expect(transport.commands).toContain(`pkill -f "$HOME"/'.local/share/[o]pen-mcc' || true`)
	})

	it("never deletes an account, since every bot runs as the one it connects as", async () => {
		const transport = await connected(CLEAN)

		await tearDownHost(transport)

		expect(transport.commands.some((command) => /userdel|groupdel/.test(command))).toBe(false)
	})

	it("reports what it could not clean rather than claiming success", async () => {
		const transport = await connected({ ...CLEAN, [INSTANCES_LEFT]: answer("present") })

		const report = await tearDownHost(transport)

		expect(report.directoryRemoved).toBe(false)
		expect(report.remaining.join(" ")).toContain(".local/share/open-mcc")
	})

	it("says lingering is still enabled, since removing it needs root the manager does not have", async () => {
		const transport = await connected({ ...CLEAN, [LINGER]: answer("yes") })

		const report = await tearDownHost(transport)

		expect(report.lingeringLeft).toBe(true)
	})
})

describe("sweeping leftover processes without killing the sweep itself", () => {
	it("hides the pattern from its own command line, which pkill would otherwise match", () => {
		expect(selfExcludingPattern(".local/share/open-mcc")).toBe(".local/share/[o]pen-mcc")
	})

	it("still matches the real path, since the class matches its own first character", () => {
		const pattern = selfExcludingPattern("/home/pi/.local/share/open-mcc")

		expect(new RegExp(pattern).test("/home/pi/.local/share/open-mcc/bin/MinecraftClient")).toBe(
			true,
		)
	})

	it("does not match the command that carries the pattern, which is the whole point", () => {
		const pattern = selfExcludingPattern("/home/pi/.local/share/open-mcc")

		expect(new RegExp(pattern).test(`pkill -f ${pattern}`)).toBe(false)
	})

	it("tolerates a trailing slash rather than producing an empty class", () => {
		expect(selfExcludingPattern(".local/share/open-mcc/")).toBe(".local/share/[o]pen-mcc")
	})

	it("quotes the guarded pattern, so the shell cannot expand the class against the real directory", async () => {
		const transport = await connected(CLEAN)

		await tearDownHost(transport)

		expect(transport.commands.some((c) => c.includes("'.local/share/[o]pen-mcc'"))).toBe(true)
		expect(transport.commands.some((c) => c.includes("[o]pen-mcc") && !c.includes("'"))).toBe(false)
	})
})

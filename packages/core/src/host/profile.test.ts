import { describe, expect, it } from "vitest"
import {
	installTarget,
	journalctl,
	profileFrom,
	rootlessProfile,
	systemctl,
	systemProfile,
	usesPerInstanceUsers,
} from "./profile"

describe("choosing where a host keeps its files", () => {
	it("puts everything under the connecting user's home when the manager has no root", () => {
		const profile = rootlessProfile("/home/mccuser")

		expect(profile.instancesRoot).toBe("/home/mccuser/.local/share/open-mcc")
		expect(profile.unitDir).toBe("/home/mccuser/.config/systemd/user")
	})

	it("tolerates a home directory reported with a trailing slash", () => {
		expect(rootlessProfile("/home/mccuser/").instancesRoot).toBe(
			"/home/mccuser/.local/share/open-mcc",
		)
	})

	it("rejects a home directory that could smuggle shell metacharacters into a path", () => {
		expect(() => rootlessProfile("/home/$(id -u)")).toThrow(/absolute path/)
		expect(() => rootlessProfile("/home/a;rm -rf /")).toThrow(/absolute path/)
	})

	it("uses system locations when the manager has root", () => {
		const profile = systemProfile()

		expect(profile.instancesRoot).toBe("/srv/open-mcc")
		expect(profile.unitDir).toBe("/etc/systemd/system")
	})
})

describe("addressing systemd for a host", () => {
	it("talks to the user manager and supplies a runtime directory over a non-login connection", () => {
		const command = systemctl(rootlessProfile("/home/mccuser"), "start open-mcc@abc.service")

		expect(command).toContain("--user")
		expect(command).toContain("XDG_RUNTIME_DIR=/run/user/$(id -u)")
	})

	it("talks to the system manager when running as root", () => {
		const command = systemctl(systemProfile(), "start open-mcc@abc.service")

		expect(command).toBe("systemctl start open-mcc@abc.service")
		expect(command).not.toContain("--user")
	})

	it("reads the matching journal in each mode", () => {
		expect(journalctl(rootlessProfile("/home/u"), "-u x")).toContain("journalctl --user")
		expect(journalctl(systemProfile(), "-u x")).toBe("journalctl -u x")
	})
})

describe("what each mode implies", () => {
	it("only creates a user per instance when it has the privilege to do so", () => {
		expect(usesPerInstanceUsers(systemProfile())).toBe(true)
		expect(usesPerInstanceUsers(rootlessProfile("/home/u"))).toBe(false)
	})

	it("enables units against the target that exists in each manager", () => {
		expect(installTarget(systemProfile())).toBe("multi-user.target")
		expect(installTarget(rootlessProfile("/home/u"))).toBe("default.target")
	})

	it("rebuilds a stored profile without re-deriving it from a home directory", () => {
		const profile = profileFrom(
			"rootless",
			"/home/u/.local/share/open-mcc",
			"/home/u/.config/systemd/user",
		)

		expect(profile.mode).toBe("rootless")
		expect(systemctl(profile, "daemon-reload")).toContain("--user")
	})
})

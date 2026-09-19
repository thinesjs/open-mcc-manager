import { describe, expect, it } from "vitest"
import { instanceDir } from "../instance/unit"
import { INSTANCES_ROOT, isUsableHome, journalctl, systemctl, UNIT_DIR } from "./profile"

describe("where every host keeps its files", () => {
	it("roots every path at the connecting account's home, as a shell word", () => {
		expect(INSTANCES_ROOT).toBe('"$HOME"/.local/share/open-mcc')
		expect(UNIT_DIR).toBe('"$HOME"/.config/systemd/user')

		for (const path of [INSTANCES_ROOT, UNIT_DIR, instanceDir("abc123")]) {
			expect(path.startsWith('"$HOME"/')).toBe(true)
		}
	})
})

describe("the home directory those paths are rooted at", () => {
	it("is usable when it is a plain absolute path and matches the account's own entry byte for byte", () => {
		expect(isUsableHome("/home/mcc", "/home/mcc")).toBe(true)
		expect(isUsableHome("/home/mcc/", "/home/mcc/")).toBe(true)
		expect(isUsableHome("/home/mcc/", "/home/mcc")).toBe(false)
	})

	it("is refused when either side carries whitespace or a control character", () => {
		for (const home of [
			" /home/mcc",
			"/home/mcc ",
			"/home/m cc",
			"/home/mcc\n",
			"/home/m\tcc",
			"/home/mcc\u0000",
		]) {
			expect(isUsableHome(home, home)).toBe(false)
			expect(isUsableHome("/home/mcc", home)).toBe(false)
		}
	})

	it("is refused when it could smuggle shell metacharacters into a unit", () => {
		expect(isUsableHome("/home/$(id -u)", "/home/$(id -u)")).toBe(false)
		expect(isUsableHome("/home/a;rm -rf /", "/home/a;rm -rf /")).toBe(false)
		expect(isUsableHome("home/mcc", "home/mcc")).toBe(false)
	})

	it("is refused when the session's HOME is not the home systemd will expand %h to", () => {
		expect(isUsableHome("/srv/elsewhere", "/home/mcc")).toBe(false)
		expect(isUsableHome("/home/mcc", "")).toBe(false)
	})
})

describe("addressing systemd on a host", () => {
	it("always talks to the user manager, with a runtime directory over a non-login connection", () => {
		expect(systemctl("start open-mcc@abc.service")).toBe(
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user start open-mcc@abc.service",
		)
	})

	it("always reads the user journal", () => {
		expect(journalctl("-u x")).toBe("XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u x")
	})
})

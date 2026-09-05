import { describe, expect, it } from "vitest"
import { fingerprintCommand, hostSetupScript, requiresRootAccount } from "./host-setup"

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI manager key"

describe("the command an operator pastes onto a new host", () => {
	it("is one paste, not a list of steps to get right in order", () => {
		const script = hostSetupScript("rootless", "pi", KEY)

		expect(script.startsWith("sudo sh -s <<'OPENMCC_SETUP'")).toBe(true)
		expect(script.trimEnd().endsWith("OPENMCC_SETUP")).toBe(true)
	})

	it("resolves the account's own home, so running it as root does not write to root's", () => {
		const script = hostSetupScript("rootless", "pi", KEY)

		expect(script).toContain('home=$(getent passwd "$account" | cut -d: -f6')
		expect(script).not.toContain("~/.ssh")
	})

	it("carries the key through a quoted heredoc, so nothing in it can be expanded", () => {
		const script = hostSetupScript("rootless", "pi", "ssh-ed25519 AAAA $HOME `id` 'x'")

		expect(script).toContain("<<'OPENMCC_KEY'")
		expect(script).toContain("ssh-ed25519 AAAA $HOME `id` 'x'")
	})

	it("adds the key only when it is missing, so running it twice leaves one copy", () => {
		const script = hostSetupScript("rootless", "pi", KEY)

		expect(script).toContain('grep -qxF "$key"')
		expect(script).toContain('>> "$home/.ssh/authorized_keys"')
	})

	it("gives the file to the account rather than leaving it owned by root", () => {
		expect(hostSetupScript("rootless", "pi", KEY)).toContain(
			'chown "$account:" "$home/.ssh/authorized_keys"',
		)
	})

	it("stops rather than continuing when the account does not exist", () => {
		expect(hostSetupScript("rootless", "pi", KEY)).toContain("There is no account called")
	})

	it("refuses an architecture with no client build, instead of installing something that cannot run", () => {
		const script = hostSetupScript("rootless", "pi", KEY)

		expect(script).toContain("x86_64|amd64|aarch64|arm64")
		expect(script).toContain("There is no client build for $machine")
	})

	it("finds the libicu package without hardcoding a version that will age out", () => {
		expect(hostSetupScript("rootless", "pi", KEY)).toContain("'^libicu[0-9]+$'")
	})

	it("ends by printing the fingerprint the next step asks for", () => {
		expect(hostSetupScript("rootless", "pi", KEY)).toContain(fingerprintCommand())
	})

	it("quotes an account name that would otherwise break out of the script", () => {
		expect(hostSetupScript("rootless", "pi'; rm -rf /", KEY)).toContain("'pi'\\''; rm -rf /'")
	})
})

describe("what each mode adds to that command", () => {
	it("enables lingering for a rootless host, since provisioning refuses without it", () => {
		expect(hostSetupScript("rootless", "pi", KEY)).toContain('loginctl enable-linger "$account"')
	})

	it("does not ask a root-owned host for lingering, which it does not use", () => {
		expect(hostSetupScript("system", "root", KEY)).not.toContain("enable-linger")
	})

	it("catches a root-owned host being set up under an account that is not root", () => {
		expect(hostSetupScript("system", "root", KEY)).toContain('if [ "$account" != "root" ]')
		expect(requiresRootAccount("system", "pi")).toBe(true)
		expect(requiresRootAccount("rootless", "pi")).toBe(false)
	})
})

describe("reading the fingerprint on its own", () => {
	it("reads it from the host's key file rather than over the network", () => {
		expect(fingerprintCommand()).toContain("/etc/ssh/ssh_host_ed25519_key.pub")
		expect(fingerprintCommand()).not.toContain("ssh-keyscan")
	})
})

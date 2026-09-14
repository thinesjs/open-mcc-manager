import { describe, expect, it } from "vitest"
import * as hostSetup from "./host-setup"
import { fingerprintCommand, hostSetupScript, setupSummary } from "./host-setup"

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI manager key"

const ACCOUNT_STEP = 'setsid su -s /bin/sh "$account" -c "$authorise"'
const STRIP_CONTROL = "tr -d '\\000-\\010\\013-\\037\\177'"

describe("the command an operator pastes onto a new host", () => {
	it("is one paste, not a list of steps to get right in order", () => {
		const script = hostSetupScript("pi", KEY)

		expect(script.startsWith("sudo sh -s <<'OPENMCC_SETUP'")).toBe(true)
		expect(script.trimEnd().endsWith("OPENMCC_SETUP")).toBe(true)
	})

	it("resolves the account's own home, so running it as root does not write to root's", () => {
		const script = hostSetupScript("pi", KEY)

		expect(script).toContain('home=$(getent passwd "$account" | cut -d: -f6')
		expect(script).not.toContain("~/.ssh")
	})

	it("carries the key through a quoted heredoc, so nothing in it can be expanded", () => {
		const script = hostSetupScript("pi", "ssh-ed25519 AAAA $HOME `id` 'x'")

		expect(script).toContain("<<'OPENMCC_KEY'")
		expect(script).toContain("ssh-ed25519 AAAA $HOME `id` 'x'")
	})

	it("adds the key only when it is missing, so running it twice leaves one copy", () => {
		const script = hostSetupScript("pi", KEY)

		expect(script).toContain('awk -v blob="$material" -f "$scan"')
		expect(script).toContain('>> "$home/.ssh/authorized_keys"')
	})

	it("skips comment lines when checking whether the key is already there", () => {
		const script = hostSetupScript("pi", KEY)

		expect(script).toContain("/^[ \\t]*#/ { next }")
	})

	it("stops on any option carrying a quote or an equals sign, rather than parsing what is inside it", () => {
		const script = hostSetupScript("pi", KEY)

		expect(script).toContain('index(f[i], "\\"") > 0 || index(f[i], "=") > 0')
	})

	it("accepts only an exact allowlist of bare options, and requires port-forwarding alongside restrict", () => {
		const script = hostSetupScript("pi", KEY)

		expect(script).toContain(
			't == "pty" || t == "no-pty" || t == "agent-forwarding" || t == "no-agent-forwarding" || t == "X11-forwarding" || t == "no-X11-forwarding" || t == "user-rc" || t == "no-user-rc"',
		)
		expect(script).toContain("if (ok && (!has_restrict || has_portfwd)) is_clean = 1")
	})

	it("decides present, clean and the stop line from the first matching record alone", () => {
		const script = hostSetupScript("pi", KEY)

		expect(script).toContain("decided { next }")
		expect(script).toContain("decided = 1")
	})

	it("names the offending line number, never the key material, when it stops", () => {
		const script = hostSetupScript("pi", KEY)
		const stopLine = script
			.split("\n")
			.find((line) => line.includes("restricts it in a way that would block the manager"))

		expect(stopLine).toBeDefined()
		expect(stopLine).toContain("$badline")
		expect(stopLine).not.toContain("$key")
		expect(stopLine).not.toContain("$material")
	})

	it("writes the account's ssh files as that account, so a link it planted cannot aim root at another file", () => {
		const script = hostSetupScript("pi", KEY)

		expect(script).toContain(`said=$(printf '%s\\n' "$key" | ${ACCOUNT_STEP} 2>&1)`)
		expect(script).not.toContain("chown")
		expect(script).not.toContain("install -d")
	})

	it("captures the step's output rather than giving it the terminal, and strips control bytes before printing", () => {
		const script = hostSetupScript("pi", KEY)

		expect(script).toContain(`said=$(printf '%s\\n' "$key" | ${ACCOUNT_STEP} 2>&1)`)
		expect(script).toContain(`printf '%s\\n' "$said" | ${STRIP_CONTROL} >&2`)
		expect(script).toContain(`printf '%s\\n' "$said" | ${STRIP_CONTROL}\n`)
	})

	it("stops rather than continuing when the account does not exist", () => {
		expect(hostSetupScript("pi", KEY)).toContain("There is no account called")
	})

	it("refuses an architecture with no client build, instead of installing something that cannot run", () => {
		const script = hostSetupScript("pi", KEY)

		expect(script).toContain("x86_64|amd64|aarch64|arm64")
		expect(script).toContain("There is no client build for $machine")
	})

	it("ends by printing the fingerprint the next step asks for", () => {
		expect(hostSetupScript("pi", KEY)).toContain(fingerprintCommand())
	})

	it("quotes an account name that would otherwise break out of the script", () => {
		expect(hostSetupScript("pi'; rm -rf /", KEY)).toContain("'pi'\\''; rm -rf /'")
	})
})

describe("what the command does on every host", () => {
	it("enables lingering, since provisioning refuses without it", () => {
		expect(hostSetupScript("pi", KEY)).toContain('loginctl enable-linger "$account"')
		expect(setupSummary("pi")).toContain(
			"Enables lingering, so instances keep running after you log out",
		)
	})

	it("has no branch asking for root, since no host is set up to run bots as root", () => {
		const script = hostSetupScript("root", KEY)

		expect(script).not.toContain('if [ "$account" != "root" ]')
		expect(script).not.toContain("is not root")
		expect(Object.keys(hostSetup)).not.toContain("requiresRootAccount")
	})
})

describe("preparing a host to run bots in Podman", () => {
	it("refuses an account whose uid is 0 before it authorises any key", () => {
		const script = hostSetupScript("pi", KEY)
		const refusal = script.indexOf("Bots can't run as root. Use a normal account.")

		expect(script).toContain('[ "$(id -u "$account")" = 0 ]')
		expect(refusal).toBeGreaterThan(-1)
		expect(refusal).toBeLessThan(script.indexOf(ACCOUNT_STEP))
		expect(refusal).toBeLessThan(script.indexOf("loginctl enable-linger"))
	})

	it("carries --no-remove on every apt-get install, so a conflict stops rather than removes", () => {
		const installs = hostSetupScript("pi", KEY).match(/apt-get [^\n]*install[^\n]*/g) ?? []

		expect(installs.length).toBeGreaterThan(0)
		for (const install of installs) expect(install).toContain("--no-remove")
	})

	it("installs Podman only when it is missing, with the helper its candidate major needs", () => {
		const script = hostSetupScript("pi", KEY)

		expect(script).toContain("command -v podman")
		expect(script).toContain("apt-cache policy podman")
		expect(script).toContain('helper=slirp4netns; [ "$major" -ge 5 ] && helper=passt')
		expect(script).toContain(
			'apt-get install -y -qq -o Dpkg::Use-Pty=0 --no-install-recommends --no-remove podman uidmap "$helper" catatonit dbus-user-session',
		)
	})

	it("adds a subordinate id range to each file that has none for the account", () => {
		const script = hostSetupScript("pi", KEY)

		expect(script).toContain('usermod --add-subuids "$range" "$account"')
		expect(script).toContain('usermod --add-subgids "$range" "$account"')
		expect(script).toContain("/etc/subuid")
		expect(script).toContain("/etc/subgid")
	})

	it("installs nothing for the old client runtime", () => {
		expect(hostSetupScript("pi", KEY)).not.toContain("libicu")
		expect(setupSummary("pi").join(" ")).not.toContain("libicu")
	})

	it("says a distribution without apt isn't supported yet, instead of trying dnf or apk", () => {
		const script = hostSetupScript("pi", KEY)

		expect(script).toContain("This distribution isn't supported yet.")
		expect(script).not.toContain("dnf")
		expect(script).not.toContain("apk")
	})

	it("tells the operator it installs Podman and lets the account run containers", () => {
		expect(setupSummary("pi")).toEqual([
			"Authorises this deployment's key for pi",
			"Enables lingering, so instances keep running after you log out",
			"Checks this machine has a client build",
			"Installs Podman if it is missing",
			"Lets pi run containers",
			"Prints the host key fingerprint for the next step",
		])
	})
})

describe("reading the fingerprint on its own", () => {
	it("reads it from the host's key file rather than over the network", () => {
		expect(fingerprintCommand()).toContain("/etc/ssh/ssh_host_ed25519_key.pub")
		expect(fingerprintCommand()).not.toContain("ssh-keyscan")
	})
})

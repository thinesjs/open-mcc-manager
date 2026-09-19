import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import * as hostSetup from "./host-setup"
import {
	ACCOUNT_NAME_PATTERN,
	fingerprintCommand,
	hostSetupScript,
	LOCK_STATE_FUNCTION,
	lockedNotice,
	setupSummary,
} from "./host-setup"

const lockState = (field: string): string =>
	execFileSync("/bin/sh", ["-c", `${LOCK_STATE_FUNCTION}\nlock_state "$1"`, "lock_state", field], {
		encoding: "utf8",
	})

const HASH = "$y$j9T$XgQnU2/qyO4T1vM4NjH/B0$r2aUF0xI1c7T1eHyOw78CJRzPNrUB4Dfehx1AyeQK22"

const HASH_WITH_LK = "$y$j9T$aLKb2/qyO4T1vM4NjH/B0$r2aUF0xI1c7T1eHyOw78CJRzPNrUB4Dfehx1AyeQK22"

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI manager key"

const ACCOUNT_STEP = 'setsid su -s /bin/sh "$account" -c "$authorise"'
const STRIP_CONTROL = "tr -d '\\000-\\010\\013-\\037\\177'"

describe("the command an operator pastes onto a new host", () => {
	it("is one paste, not a list of steps to get right in order", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script.startsWith("sudo sh -s <<'OPENMCC_SETUP'")).toBe(true)
		expect(script.trimEnd().endsWith("OPENMCC_SETUP")).toBe(true)
	})

	it("asks for root through sudo, since the operator pasting it is not root yet", () => {
		expect(hostSetupScript("pi", KEY, false)).toBe(hostSetupScript("pi", KEY, false, "ask", "sudo"))
	})

	it("asks for nothing on a connection that is already root, since a minimal Debian has no sudo", () => {
		const asRoot = hostSetupScript("pi", KEY, false, "ask", "none")

		expect(asRoot.startsWith("sh -s <<'OPENMCC_SETUP'")).toBe(true)
		expect(`sudo ${asRoot}`).toBe(hostSetupScript("pi", KEY, false, "ask", "sudo"))
	})

	it("resolves the account's own home, so running it as root does not write to root's", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain('home=$(getent passwd "$account" | cut -d: -f6')
		expect(script).not.toContain("~/.ssh")
	})

	it("carries the key through a quoted heredoc, so nothing in it can be expanded", () => {
		const script = hostSetupScript("pi", "ssh-ed25519 AAAA $HOME `id` 'x'", false)

		expect(script).toContain("<<'OPENMCC_KEY'")
		expect(script).toContain("ssh-ed25519 AAAA $HOME `id` 'x'")
	})

	it("adds the key only when it is missing, so running it twice leaves one copy", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain('awk -v blob="$material" -f "$scan"')
		expect(script).toContain('>> "$home/.ssh/authorized_keys"')
	})

	it("skips comment lines when checking whether the key is already there", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain("/^[ \\t]*#/ { next }")
	})

	it("stops on any option carrying a quote or an equals sign, rather than parsing what is inside it", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain('index(f[i], "\\"") > 0 || index(f[i], "=") > 0')
	})

	it("accepts only an exact allowlist of bare options, and requires port-forwarding alongside restrict", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain(
			't == "pty" || t == "no-pty" || t == "agent-forwarding" || t == "no-agent-forwarding" || t == "X11-forwarding" || t == "no-X11-forwarding" || t == "user-rc" || t == "no-user-rc"',
		)
		expect(script).toContain("if (ok && (!has_restrict || has_portfwd)) is_clean = 1")
	})

	it("decides present, clean and the stop line from the first matching record alone", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain("decided { next }")
		expect(script).toContain("decided = 1")
	})

	it("names the offending line number, never the key material, when it stops", () => {
		const script = hostSetupScript("pi", KEY, false)
		const stopLine = script
			.split("\n")
			.find((line) => line.includes("restricts it in a way that would block the manager"))

		expect(stopLine).toBeDefined()
		expect(stopLine).toContain("$badline")
		expect(stopLine).not.toContain("$key")
		expect(stopLine).not.toContain("$material")
	})

	it("writes the account's ssh files as that account, so a link it planted cannot aim root at another file", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain(`said=$(printf '%s\\n' "$key" | ${ACCOUNT_STEP} 2>&1)`)
		expect(script).not.toContain("chown")
		expect(script).not.toContain("install -d")
	})

	it("captures the step's output rather than giving it the terminal, and strips control bytes before printing", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain(`said=$(printf '%s\\n' "$key" | ${ACCOUNT_STEP} 2>&1)`)
		expect(script).toContain(`printf '%s\\n' "$said" | ${STRIP_CONTROL} >&2`)
		expect(script).toContain(`printf '%s\\n' "$said" | ${STRIP_CONTROL}\n`)
	})

	it("stops rather than continuing when the account does not exist", () => {
		expect(hostSetupScript("pi", KEY, false)).toContain("There is no account called")
	})

	it("refuses an architecture with no client build, instead of installing something that cannot run", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain("x86_64|amd64|aarch64|arm64")
		expect(script).toContain("There is no client build for $machine")
	})

	it("ends by printing the fingerprint the next step asks for", () => {
		expect(hostSetupScript("pi", KEY, false)).toContain(fingerprintCommand())
	})

	it("quotes an account name that would otherwise break out of the script", () => {
		expect(hostSetupScript("pi'; rm -rf /", KEY, false)).toContain("'pi'\\''; rm -rf /'")
	})
})

describe("what the command does on every host", () => {
	it("enables lingering, since provisioning refuses without it", () => {
		expect(hostSetupScript("pi", KEY, false)).toContain('loginctl enable-linger "$account"')
		expect(setupSummary("pi", "deploy", false)).toContain(
			"Enables lingering, so instances keep running after you log out",
		)
	})

	it("has no branch asking for root, since no host is set up to run bots as root", () => {
		const script = hostSetupScript("root", KEY, false)

		expect(script).not.toContain('if [ "$account" != "root" ]')
		expect(script).not.toContain("is not root")
		expect(Object.keys(hostSetup)).not.toContain("requiresRootAccount")
	})
})

describe("preparing a host to run bots in Podman", () => {
	it("refuses an account whose uid is 0 before it authorises any key", () => {
		const script = hostSetupScript("pi", KEY, false)
		const refusal = script.indexOf("Bots can't run as root. Use a normal account.")

		expect(script).toContain('[ "$(id -u "$account")" = 0 ]')
		expect(refusal).toBeGreaterThan(-1)
		expect(refusal).toBeLessThan(script.indexOf(ACCOUNT_STEP))
		expect(refusal).toBeLessThan(script.indexOf("loginctl enable-linger"))
	})

	it("carries --no-remove on every apt-get install, so a conflict stops rather than removes", () => {
		const installs = hostSetupScript("pi", KEY, false).match(/apt-get [^\n]*install[^\n]*/g) ?? []

		expect(installs.length).toBeGreaterThan(0)
		for (const install of installs) expect(install).toContain("--no-remove")
	})

	it("installs Podman only when it is missing, with the helper its candidate major needs", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain("command -v podman")
		expect(script).toContain("apt-cache policy podman")
		expect(script).toContain('helper=slirp4netns; [ "$major" -ge 5 ] && helper=passt')
		expect(script).toContain(
			'apt-get install -y -qq -o Dpkg::Use-Pty=0 --no-install-recommends --no-remove podman uidmap "$helper" catatonit dbus-user-session',
		)
	})

	it("adds a subordinate id range to each file that has none for the account", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain('usermod --add-subuids "$range" "$account"')
		expect(script).toContain('usermod --add-subgids "$range" "$account"')
		expect(script).toContain("/etc/subuid")
		expect(script).toContain("/etc/subgid")
	})

	it("installs nothing for the old client runtime", () => {
		expect(hostSetupScript("pi", KEY, false)).not.toContain("libicu")
		expect(setupSummary("pi", "deploy", false).join(" ")).not.toContain("libicu")
	})

	it("says a distribution without apt isn't supported yet, instead of trying dnf or apk", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain("This distribution isn't supported yet.")
		expect(script).not.toContain("dnf")
		expect(script).not.toContain("apk")
	})

	it("tells the operator it installs Podman and lets the account run containers", () => {
		expect(setupSummary("pi", "deploy", false)).toEqual([
			"Offers to unlock pi if it is locked",
			"Authorises the key deploy for pi",
			"Enables lingering, so instances keep running after you log out",
			"Checks this machine has a client build",
			"Installs Podman if it is missing",
			"Lets pi run containers",
			"Prints the host key fingerprint for the next step",
		])
	})

	it("names account creation only on the path that creates one", () => {
		expect(setupSummary("pi", "deploy", true)[0]).toBe("Creates the account pi if it is missing")
		expect(setupSummary("pi", "deploy", false)).not.toContain(
			"Creates the account pi if it is missing",
		)
	})

	it("names the key the command carries, since changing it means running the command again", () => {
		expect(setupSummary("pi", "deploy", false)).toContain("Authorises the key deploy for pi")
		expect(setupSummary("pi", "spare", false)).toContain("Authorises the key spare for pi")
	})
})

describe("reading the fingerprint on its own", () => {
	it("reads it from the host's key file rather than over the network", () => {
		expect(fingerprintCommand()).toContain("/etc/ssh/ssh_host_ed25519_key.pub")
		expect(fingerprintCommand()).not.toContain("ssh-keyscan")
	})
})

const CREATE_STEP = "if ! made=$(useradd --create-home --shell /bin/sh --password '*'"

const asShellText = (text: string): string => text.replace(/'/g, "'\\''")

const executedIn = (script: string): string =>
	script
		.split("\n")
		.filter((line) => !/^\s*(echo|printf)\b/.test(line))
		.join("\n")

const LOCK_READ = "if { read -r reply < /dev/tty; } 2>/dev/null; then answer=$reply; fi"

const LOCK_PROMPT = "printf 'Unlock %s now? [y/N] ' \"$account\" >&2"

describe("setting up the account the bots run as", () => {
	it("creates it only on the path where the operator asked for one", () => {
		expect(hostSetupScript("pi", KEY, true)).toContain(CREATE_STEP)
		expect(executedIn(hostSetupScript("pi", KEY, false))).not.toContain("useradd")
	})

	it("creates it only when it is missing, and leaves one that is already there alone", () => {
		const script = hostSetupScript("pi", KEY, true)
		const guard = script.indexOf('home=$(getent passwd "$account" | cut -d: -f6 || true)')

		expect(guard).toBeGreaterThan(-1)
		expect(script.indexOf('if [ -z "$home" ]')).toBeGreaterThan(guard)
		expect(script).toContain('echo "  account $account already exists, left alone"')
	})

	it("gives the new account a password no login can match, since a locked one is refused a key", () => {
		const line = hostSetupScript("pi", KEY, true)
			.split("\n")
			.find((text) => text.includes("made=$(useradd"))

		expect(line).toBeDefined()
		expect(line).toContain("--password '*'")
		expect(line).toContain("--create-home")
		expect(line).not.toContain("--password ''")
	})

	it("names both ways forward when the account is missing and none was asked for", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain("There is no account called $account on this host.")
		expect(script).toContain('Either go back to the Account step and choose "Create it for me",')
		expect(script).toContain(
			asShellText(
				"or run this first: sudo useradd --create-home --shell /bin/sh --password '*' -- 'pi'",
			),
		)
	})

	it("quotes the account name in the command it tells the operator to run", () => {
		expect(hostSetupScript("pi'; rm -rf /", KEY, false)).toContain(
			asShellText("--password '*' -- 'pi'\\''; rm -rf /'"),
		)
	})

	it("ends the options of every command it runs, so no name is read as one", () => {
		const executed = executedIn(hostSetupScript("pi", KEY, true))
		const commands = executed.match(/(useradd|usermod -[pU]|chsh)[^\n]*/g) ?? []

		expect(commands.length).toBeGreaterThan(2)
		for (const command of commands) expect(command).toContain("-- 'pi'")
	})

	it("accepts only account names useradd itself would take", () => {
		for (const name of ["mcc", "m", "bots-1", "_x", "a_b-c9"]) {
			expect(ACCOUNT_NAME_PATTERN.test(name)).toBe(true)
		}
		for (const name of [
			"",
			"Mcc",
			"9bots",
			"-bots",
			"my account",
			"pi'; rm -rf /",
			"a".repeat(33),
			"OPENMCC_SETUP",
		]) {
			expect(ACCOUNT_NAME_PATTERN.test(name)).toBe(false)
		}
	})
})

describe("an account that is already there but locked", () => {
	it.each([true, false])("is detected on both paths, with createAccount %s", (createAccount) => {
		const script = hostSetupScript("pi", KEY, createAccount)

		expect(script).toContain(
			'lock_state "$(getent shadow "$account" 2>/dev/null | cut -d: -f2 || true)"',
		)
		expect(script).toContain(LOCK_STATE_FUNCTION)
	})

	it.each([
		{ field: "!", state: "none" },
		{ field: "!!", state: "none" },
		{ field: "!*", state: "none" },
		{ field: `!${HASH}`, state: "password" },
		{ field: "!x", state: "password" },
		{ field: "*", state: "open" },
		{ field: "", state: "open" },
		{ field: HASH, state: "open" },
		{ field: HASH_WITH_LK, state: "open" },
	])("reads a shadow field of $field as $state", ({ field, state }) => {
		expect(lockState(field)).toBe(state)
	})

	it("puts a locked real password back rather than overwriting it", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain("usermod -U -- 'pi' || true")
		expect(script).toContain("usermod -p '*' -- 'pi' || true")
		expect(script).toContain("if [ \"$state\" = password ]; then\n        usermod -U -- 'pi'")
	})

	it("says a password is being put back before it asks about an account that has one", () => {
		const script = hostSetupScript("pi", KEY, false)
		const said = script.indexOf(
			"It has a password. Unlocking puts that password back exactly as it was, and changes nothing else.",
		)

		expect(said).toBeGreaterThan(-1)
		expect(said).toBeLessThan(script.indexOf(LOCK_PROMPT))
		expect(script.indexOf(LOCK_PROMPT)).toBeLessThan(script.indexOf(LOCK_READ))
		expect(script).toContain("It has no password, and unlocking gives it none. It stays key-only.")
	})

	it("confirms the account came unlocked rather than trusting the exit status", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain(
			'if [ "$(lock_state "$(getent shadow "$account" 2>/dev/null | cut -d: -f2 || true)")" != open ]; then',
		)
		expect(script).toContain('echo "Could not unlock $account." >&2')
	})

	it("says what being locked means before it asks anything", () => {
		const script = hostSetupScript("pi", KEY, false)
		const said = script.indexOf(lockedNotice("pi"))

		expect(said).toBeGreaterThan(-1)
		expect(said).toBeLessThan(script.indexOf(LOCK_PROMPT))
	})

	it("asks on the terminal, since the script itself arrives on stdin", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain(LOCK_PROMPT)
		expect(script).toContain(LOCK_READ)
	})

	it("never unlocks without an answer", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script.indexOf(LOCK_READ)).toBeLessThan(script.indexOf("usermod -U -- 'pi'"))
		expect(script.indexOf(LOCK_READ)).toBeLessThan(script.indexOf("usermod -p '*' -- 'pi'"))
		expect(script).toContain("y|Y|yes|Yes|YES)")
	})

	it("stops with the one command that fits what it found, when the answer is no", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain('echo "Left $account locked, and changed nothing." >&2')
		expect(script).toContain(
			asShellText("Unlock it yourself, then run this again: sudo usermod -p '*' -- 'pi'"),
		)
		expect(script).toContain(
			asShellText("Unlock it yourself, then run this again: sudo usermod -U -- 'pi'"),
		)
	})

	it("writes nothing to an account that was already there but the field it asked about", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(executedIn(script)).not.toContain("chsh")
		expect(executedIn(script)).not.toContain("chpasswd")
		expect(executedIn(script)).not.toContain("usermod -aG")
		expect(executedIn(script).match(/usermod -p [^\n;|]*/g)).toEqual(["usermod -p '*' -- 'pi' "])
	})
})

describe("what the command proves before it prints the fingerprint", () => {
	it("checks nothing on the account blocks a key login, rather than assuming", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain('shell=$(getent passwd "$account" | cut -d: -f7)')
		expect(script).toContain("*/nologin|*/false)")
		expect(script).toContain('if [ ! -d "$home" ]; then')
		expect(script).toContain('echo "  nothing on $account blocks a key login"')
	})

	it("runs that check after the key is in place and before the fingerprint", () => {
		const script = hostSetupScript("pi", KEY, false)
		const proof = script.indexOf('echo "  nothing on $account blocks a key login"')

		expect(proof).toBeGreaterThan(script.indexOf(ACCOUNT_STEP))
		expect(proof).toBeLessThan(script.indexOf(fingerprintCommand()))
	})

	it("names the login shell that would stop the account running anything", () => {
		const script = hostSetupScript("pi", KEY, false)

		expect(script).toContain(
			'echo "The account $account cannot run anything: its shell is $shell." >&2',
		)
		expect(script).toContain(asShellText("sudo chsh -s /bin/sh -- 'pi'"))
	})
})

describe("what stays the same whichever account path is chosen", () => {
	it.each([true, false])("refuses root, lingers and installs Podman, with %s", (createAccount) => {
		const script = hostSetupScript("pi", KEY, createAccount)

		expect(script).toContain("Bots can't run as root. Use a normal account.")
		expect(script).toContain('loginctl enable-linger "$account"')
		expect(script).toContain("command -v podman")
		expect(script).toContain("apt-cache policy podman")
	})
})

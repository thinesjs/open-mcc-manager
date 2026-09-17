import { spawn } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	hostSetupScript,
	LOCKED_HAS_NO_PASSWORD,
	LOCKED_KEEPS_PASSWORD,
	lockedNotice,
} from "./host-setup"

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI manager key"

const ACCOUNT = "mcc"

const PASSWORD_HASH = "$y$j9T$XgQnU2/qyO4T1vM4NjH/B0$r2aUF0xI1c7T1eHyOw78CJRzPNrUB4Dfehx1AyeQK22"

type Ran = {
	stdout: string
	stderr: string
	exitCode: number | null
	shadow: string
	usermod: string
}

const stub = (dir: string, name: string, body: string): void => {
	const path = join(dir, name)
	writeFileSync(path, `#!/bin/sh\n${body}\n`)
	chmodSync(path, 0o755)
}

const runWithoutTerminal = (script: string, shadowField: string): Promise<Ran> => {
	const dir = mkdtempSync(join(tmpdir(), "open-mcc-setup-"))
	writeFileSync(join(dir, "shadow"), shadowField)
	writeFileSync(join(dir, "usermod.log"), "")

	stub(dir, "sudo", 'exec "$@"')
	stub(
		dir,
		"getent",
		[
			'case "$1" in',
			'  passwd) echo "$2:x:1000:1000::/home/$2:/bin/sh" ;;',
			'  shadow) echo "$2:$(cat "$STUB_STATE/shadow"):19000:0:99999:7:::" ;;',
			"  *) exit 2 ;;",
			"esac",
		].join("\n"),
	)
	stub(
		dir,
		"id",
		[
			'if [ "$1" = "-u" ]; then echo 1000; exit 0; fi',
			'if [ "$1" = "-un" ]; then echo stub-user; exit 0; fi',
			"echo 1000",
		].join("\n"),
	)
	stub(
		dir,
		"usermod",
		[
			'echo "$@" >> "$STUB_STATE/usermod.log"',
			'case "$1" in',
			'  -U) printf %s "$(sed "s/^!//" "$STUB_STATE/shadow")" > "$STUB_STATE/shadow" ;;',
			'  -p) printf %s "$2" > "$STUB_STATE/shadow" ;;',
			"esac",
		].join("\n"),
	)

	return new Promise<Ran>((resolve, reject) => {
		const child = spawn("/bin/sh", ["-c", script], {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				STUB_STATE: dir,
				PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			},
		})
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString()
		})
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString()
		})
		child.on("error", reject)
		child.on("close", (exitCode) => {
			resolve({
				stdout,
				stderr,
				exitCode,
				shadow: readFileSync(join(dir, "shadow"), "utf8"),
				usermod: readFileSync(join(dir, "usermod.log"), "utf8"),
			})
		})
	})
}

describe("what the setup script does when there is no terminal to ask at", () => {
	it("cannot open a terminal at all, which is the condition Express runs under", async () => {
		const ran = await runWithoutTerminal(
			"if { read -r reply < /dev/tty; } 2>/dev/null; then echo opened; else echo closed; fi",
			"x",
		)

		expect(ran.stdout.trim()).toBe("closed")
	})

	it("leaves a locked account exactly as it found it, rather than unlocking unasked", async () => {
		const ran = await runWithoutTerminal(hostSetupScript(ACCOUNT, KEY, false), `!${PASSWORD_HASH}`)

		expect(ran.exitCode).not.toBe(0)
		expect(ran.usermod).toBe("")
		expect(ran.shadow).toBe(`!${PASSWORD_HASH}`)
	})

	it("says what it found and which command fixes it, rather than failing silently", async () => {
		const ran = await runWithoutTerminal(hostSetupScript(ACCOUNT, KEY, false), `!${PASSWORD_HASH}`)

		expect(ran.stderr).toContain(lockedNotice(ACCOUNT))
		expect(ran.stderr).toContain(LOCKED_KEEPS_PASSWORD)
		expect(ran.stderr).toContain(`Left ${ACCOUNT} locked, and changed nothing.`)
		expect(ran.stderr).toContain(`sudo usermod -U -- '${ACCOUNT}'`)
	})

	it("names the other command when the locked account has no password to keep", async () => {
		const ran = await runWithoutTerminal(hostSetupScript(ACCOUNT, KEY, false), "!")

		expect(ran.stderr).toContain(LOCKED_HAS_NO_PASSWORD)
		expect(ran.stderr).toContain(`sudo usermod -p '*' -- '${ACCOUNT}'`)
		expect(ran.usermod).toBe("")
	})

	it("unlocks without a terminal once the operator has already answered yes", async () => {
		const ran = await runWithoutTerminal(
			hostSetupScript(ACCOUNT, KEY, false, "grant"),
			`!${PASSWORD_HASH}`,
		)

		expect(ran.usermod).toContain(`-U -- ${ACCOUNT}`)
		expect(ran.shadow).toBe(PASSWORD_HASH)
		expect(ran.stderr).not.toContain(`Left ${ACCOUNT} locked`)
	})

	it("keeps a locked-empty account key-only when it unlocks it", async () => {
		const ran = await runWithoutTerminal(hostSetupScript(ACCOUNT, KEY, false, "grant"), "!")

		expect(ran.usermod).toContain(`-p * -- ${ACCOUNT}`)
		expect(ran.shadow).toBe("*")
	})

	it("touches nothing on an account that was never locked", async () => {
		const ran = await runWithoutTerminal(hostSetupScript(ACCOUNT, KEY, false), PASSWORD_HASH)

		expect(ran.usermod).toBe("")
		expect(ran.shadow).toBe(PASSWORD_HASH)
		expect(ran.stderr).not.toContain(lockedNotice(ACCOUNT))
	})
})

describe("the one difference between the script Express runs and the one an operator pastes", () => {
	it("is the answer to the unlock question, and nothing else", () => {
		const asked = hostSetupScript(ACCOUNT, KEY, true, "ask")
		const granted = hostSetupScript(ACCOUNT, KEY, true, "grant")

		const askedOnly = asked.split("\n").filter((line) => !granted.includes(line))
		const grantedOnly = granted.split("\n").filter((line) => !asked.includes(line))

		expect(askedOnly).toEqual([
			`  printf 'Unlock %s now? [y/N] ' "$account" >&2`,
			"  answer=n",
			"  if { read -r reply < /dev/tty; } 2>/dev/null; then answer=$reply; fi",
		])
		expect(grantedOnly).toEqual(["  answer=y"])
	})

	it("defaults to asking, so nothing that forgets to say changes an account unasked", () => {
		expect(hostSetupScript(ACCOUNT, KEY, true)).toBe(hostSetupScript(ACCOUNT, KEY, true, "ask"))
	})
})

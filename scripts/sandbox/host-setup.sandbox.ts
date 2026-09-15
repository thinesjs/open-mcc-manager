import { setTimeout as delay } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { hostSetupScript } from "../../apps/web/src/lib/host-setup"
import {
	lingerCommand,
	networkHelperCommand,
	PODMAN_INSTALL_COMMAND,
	ROOT_REFUSAL,
	subordinateIdsCommand,
} from "../../packages/core/src/host/check"
import {
	HOST_FACTS_COMMAND,
	nextSubordinateRange,
	parseHostFacts,
} from "../../packages/core/src/host/podman-facts"
import {
	exec,
	homeOf,
	mintKey,
	newAccount,
	ROOT,
	read,
	remove,
	seedAuthorizedKeys,
	shell,
	signIn,
	snapshot,
	startHost,
	succeeded,
} from "./sandbox"

const INSTALL_TIMEOUT_MS = 600_000

const setUp = (host: string, account: string, publicKey: string) =>
	shell(
		host,
		{ user: "tester", timeoutMs: INSTALL_TIMEOUT_MS },
		hostSetupScript(account, publicKey),
	)

const authorizedKeysOf = (account: string): string => `${homeOf(account)}/.ssh/authorized_keys`

const holdersOf = async (host: string, publicKey: string): Promise<string[]> => {
	const found = await shell(
		host,
		ROOT,
		'grep -lF -- "$1" /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null',
		publicKey.split(" ")[1] ?? "",
	)
	return found.stdout.split("\n").filter((line) => line.length > 0)
}

const lingers = async (host: string, account: string): Promise<boolean> => {
	const shown = await exec(host, ROOT, [
		"loginctl",
		"show-user",
		account,
		"--property=Linger",
		"--value",
	])
	return shown.stdout.trim() === "yes"
}

const userManagerOf = async (host: string, account: string): Promise<string> => {
	const uid = succeeded(await exec(host, ROOT, ["id", "-u", account]), "reading a uid").trim()
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const state = (
			await exec(host, ROOT, ["systemctl", "is-active", `user@${uid}.service`])
		).stdout.trim()
		if (state !== "activating") return state
		await delay(250)
	}
	return "activating"
}

const presentedFingerprint = async (host: string): Promise<string> =>
	succeeded(
		await shell(
			host,
			ROOT,
			"ssh-keyscan -t ed25519 127.0.0.1 2>/dev/null | ssh-keygen -lf - | awk '{print $2}'",
		),
		"reading the host key sshd presents",
	).trim()

const hasPodman = async (host: string): Promise<boolean> =>
	(await shell(host, ROOT, "command -v podman")).status === 0

const factsOf = async (host: string, account: string) =>
	parseHostFacts(
		succeeded(await shell(host, { user: account }, HOST_FACTS_COMMAND), "reading the host facts"),
	)

const accountWithoutSubordinateIds = async (host: string): Promise<string> => {
	const account = await newAccount(host)
	succeeded(
		await shell(host, ROOT, 'sed -i "/^$1:/d" /etc/subuid /etc/subgid', account),
		"removing the account's subordinate ids",
	)
	return account
}

describe("the host setup script", () => {
	let host = ""

	beforeAll(async () => {
		host = await startHost(inject("sandbox"))
	})

	afterAll(async () => {
		await remove(host)
	})

	it("authorises the key for that account alone, with the modes sshd insists on", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)

		const ran = await setUp(host, account, key.publicKey)

		expect(ran.status, ran.stderr).toBe(0)
		expect(await read(host, authorizedKeysOf(account))).toBe(`${key.publicKey}\n`)
		expect(await holdersOf(host, key.publicKey)).toEqual([authorizedKeysOf(account)])
		const modes = await exec(host, ROOT, [
			"stat",
			"-c",
			"%a %U",
			`${homeOf(account)}/.ssh`,
			authorizedKeysOf(account),
		])
		expect(modes.stdout.trim().split("\n")).toEqual([`700 ${account}`, `600 ${account}`])
	})

	it("lets that key sign in over ssh as that account, whose own systemd answers", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)

		expect((await setUp(host, account, key.publicKey)).status).toBe(0)

		const signedIn = await signIn(
			host,
			ROOT,
			key.path,
			account,
			"id -un; systemctl --user is-system-running --wait",
		)
		expect(signedIn.stdout.trim().split("\n")).toEqual([account, "running"])
	})

	it("adds nothing when it runs again", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)

		expect((await setUp(host, account, key.publicKey)).status).toBe(0)
		const once = await read(host, authorizedKeysOf(account))
		expect((await setUp(host, account, key.publicKey)).status).toBe(0)

		expect(await read(host, authorizedKeysOf(account))).toBe(once)
		expect(once).toBe(`${key.publicKey}\n`)
	})

	it("keeps an unrelated last entry that has no trailing newline exactly as it was", async () => {
		const account = await newAccount(host)
		const other = await mintKey(host)
		const key = await mintKey(host)
		await seedAuthorizedKeys(host, account, other.publicKey)

		expect((await setUp(host, account, key.publicKey)).status).toBe(0)

		expect(await read(host, authorizedKeysOf(account))).toBe(
			`${other.publicKey}\n${key.publicKey}\n`,
		)
		const asOther = await signIn(host, ROOT, other.path, account, "id -un")
		expect(asOther.stdout.trim()).toBe(account)
		const asKey = await signIn(host, ROOT, key.path, account, "id -un")
		expect(asKey.stdout.trim()).toBe(account)
	})

	it("adds the key when the only existing record for it is commented out", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)
		const blob = key.publicKey.split(" ")[1] ?? ""
		await seedAuthorizedKeys(host, account, `# revoked ${key.publicKey}\n`)

		const ran = await setUp(host, account, key.publicKey)

		expect(ran.status, ran.stderr).toBe(0)
		const lines = (await read(host, authorizedKeysOf(account))).split("\n")
		expect(lines[0]).toBe(`# revoked ${key.publicKey}`)
		expect(lines[1]).toBe(key.publicKey)
		expect(await holdersOf(host, key.publicKey)).toEqual([authorizedKeysOf(account)])
		const holderLines = (await read(host, authorizedKeysOf(account))).split("\n")
		expect(holderLines.filter((line) => line.includes(blob)).length).toBe(2)
	})

	it("refuses rather than treating a restricted match as ready, and changes nothing", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)
		const restricted = `command="/bin/echo hi there" ${key.publicKey}\n`
		await seedAuthorizedKeys(host, account, restricted)
		const before = await read(host, authorizedKeysOf(account))

		const ran = await setUp(host, account, key.publicKey)

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain("Could not authorise the key")
		expect(await read(host, authorizedKeysOf(account))).toBe(before)
	})

	it.each([
		{ shape: "permitopen=", line: (key: string) => `permitopen="127.0.0.2:*" ${key}` },
		{
			shape: "an expired expiry-time=",
			line: (key: string) => `expiry-time="202001010000" ${key}`,
		},
		{ shape: "bare restrict", line: (key: string) => `restrict ${key}` },
		{ shape: "cert-authority", line: (key: string) => `cert-authority ${key}` },
		{
			shape: "an unrelated environment=",
			line: (key: string) => `environment="A=restricted-value" ${key}`,
		},
	])(
		"refuses rather than treating a match under $shape as ready, and changes nothing",
		async ({ line }) => {
			const account = await newAccount(host)
			const key = await mintKey(host)
			await seedAuthorizedKeys(host, account, `${line(key.publicKey)}\n`)
			const before = await read(host, authorizedKeysOf(account))

			const ran = await setUp(host, account, key.publicKey)

			expect(ran.status).not.toBe(0)
			expect(ran.stderr).toContain("Could not authorise the key")
			expect(await read(host, authorizedKeysOf(account))).toBe(before)
		},
	)

	it("treats restrict,port-forwarding as ready, since live control needs forwarding", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)
		await seedAuthorizedKeys(host, account, `restrict,port-forwarding ${key.publicKey}\n`)
		const before = await read(host, authorizedKeysOf(account))

		const ran = await setUp(host, account, key.publicKey)

		expect(ran.status, ran.stderr).toBe(0)
		expect(await read(host, authorizedKeysOf(account))).toBe(before)
	})

	it("adds the key when its blob appears only inside another key's comment", async () => {
		const account = await newAccount(host)
		const other = await mintKey(host)
		const key = await mintKey(host)
		const blob = key.publicKey.split(" ")[1] ?? ""
		await seedAuthorizedKeys(host, account, `${other.publicKey} mentions-${blob}\n`)

		const ran = await setUp(host, account, key.publicKey)

		expect(ran.status, ran.stderr).toBe(0)
		const lines = (await read(host, authorizedKeysOf(account))).split("\n")
		expect(lines[0]).toBe(`${other.publicKey} mentions-${blob}`)
		expect(lines[1]).toBe(key.publicKey)
	})

	it("refuses when the first matching record is restricted, even if a later one is clean", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)
		await seedAuthorizedKeys(host, account, `restrict ${key.publicKey}\n${key.publicKey}\n`)
		const before = await read(host, authorizedKeysOf(account))

		const ran = await setUp(host, account, key.publicKey)

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain("Could not authorise the key")
		expect(await read(host, authorizedKeysOf(account))).toBe(before)
	})

	it("accepts when the first matching record is clean, even if a later one is restricted", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)
		await seedAuthorizedKeys(host, account, `${key.publicKey}\nrestrict ${key.publicKey}\n`)
		const before = await read(host, authorizedKeysOf(account))

		const ran = await setUp(host, account, key.publicKey)

		expect(ran.status, ran.stderr).toBe(0)
		expect(await read(host, authorizedKeysOf(account))).toBe(before)
	})

	it("refuses an account that does not exist, having changed nothing", async () => {
		const key = await mintKey(host)
		const watched = ["/home", "/root", "/.ssh", "/var/lib/systemd/linger"]
		const before = await snapshot(host, ...watched)

		const ran = await setUp(host, "nobody-by-that-name", key.publicKey)

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain("There is no account called nobody-by-that-name")
		expect(await snapshot(host, ...watched)).toBe(before)
	})

	it("prints the fingerprint of the host key this machine's sshd presents", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)

		const ran = await setUp(host, account, key.publicKey)

		const presented = await presentedFingerprint(host)
		expect(presented).toMatch(/^SHA256:/)
		expect(ran.stdout.trim().split("\n").at(-1)).toBe(presented)
	})

	it("leaves a root-owned file alone when the account has linked authorized_keys to it", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)
		const target = `/etc/open-mcc-sentinel-${account}`
		succeeded(
			await shell(
				host,
				{ ...ROOT, input: "root:x:0:0:root:/root:/bin/bash\n" },
				'cat > "$1" && chmod 644 "$1"',
				target,
			),
			"writing a root-owned sentinel",
		)
		succeeded(
			await shell(
				host,
				{ user: account },
				'mkdir -p "$1/.ssh" && ln -s "$2" "$1/.ssh/authorized_keys"',
				homeOf(account),
				target,
			),
			"linking authorized_keys to it as the account",
		)
		const before = await snapshot(host, target)

		await setUp(host, account, key.publicKey)

		expect(await snapshot(host, target)).toBe(before)
	})

	it("leaves a root-owned directory alone when the account has linked .ssh to it", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)
		const target = `/etc/open-mcc-sentinel-${account}.d`
		succeeded(
			await shell(
				host,
				{ ...ROOT, input: "root owns this\n" },
				'mkdir "$1" && cat > "$1/keep" && chmod 755 "$1" && chmod 644 "$1/keep"',
				target,
			),
			"writing a root-owned sentinel directory",
		)
		succeeded(
			await shell(host, { user: account }, 'ln -s "$2" "$1/.ssh"', homeOf(account), target),
			"linking .ssh to it as the account",
		)
		const before = await snapshot(host, target)

		await setUp(host, account, key.publicKey)

		expect(await snapshot(host, target)).toBe(before)
	})

	it("turns lingering on for every account, so its systemd runs with nobody logged in", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)
		expect(await lingers(host, account)).toBe(false)

		expect((await setUp(host, account, key.publicKey)).status).toBe(0)

		expect(await lingers(host, account)).toBe(true)
		expect(await userManagerOf(host, account)).toBe("active")
	})
})

describe("the host setup script, when the account step prints an escape sequence", () => {
	let host = ""

	beforeAll(async () => {
		host = await startHost(inject("sandbox"))
		succeeded(
			await shell(
				host,
				{
					...ROOT,
					input: [
						"#!/bin/sh",
						"printf '\\033[1Aowned\\n'",
						"printf '\\033[1Aowned\\n' >&2",
						'exec /usr/bin/su "$@"',
						"",
					].join("\n"),
				},
				"cat > /usr/local/bin/su && chmod 755 /usr/local/bin/su",
			),
			"installing a su that emits an escape sequence, as a compromised account's surviving child would",
		)
	})

	afterAll(async () => {
		await remove(host)
	})

	it("shows no escape byte from it, so the account cannot rewrite the fingerprint root prints", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)

		const ran = await setUp(host, account, key.publicKey)

		expect(ran.status, ran.stderr).toBe(0)
		expect(ran.stdout).toContain("owned")
		expect(ran.stdout).not.toContain("\u001b")
		expect(ran.stderr).not.toContain("\u001b")
		expect(await read(host, authorizedKeysOf(account))).toBe(`${key.publicKey}\n`)
	})
})

describe("the host setup script, on a plain host without Podman", () => {
	let host = ""

	beforeAll(async () => {
		host = await startHost(inject("sandbox"))
	})

	afterAll(async () => {
		await remove(host)
	})

	it("refuses a root account before changing anything", async () => {
		const key = await mintKey(host)
		const watched = ["/root", "/var/lib/systemd/linger", "/etc/subuid", "/etc/subgid"]
		const before = await snapshot(host, ...watched)

		const ran = await setUp(host, "root", key.publicKey)

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain(ROOT_REFUSAL)
		expect(await snapshot(host, ...watched)).toBe(before)
		expect(await hasPodman(host)).toBe(false)
	})

	it("installs Podman, and gives an account with no subordinate ids a range after the highest", async () => {
		expect(await hasPodman(host)).toBe(false)
		const account = await accountWithoutSubordinateIds(host)
		const key = await mintKey(host)
		const before = await factsOf(host, account)
		expect(before.subuid.own || before.subgid.own).toBe(false)
		const range = nextSubordinateRange(before.subuid.ranges, before.subgid.ranges)

		const ran = await setUp(host, account, key.publicKey)

		expect(ran.status, ran.stderr).toBe(0)
		expect(ran.stdout).toContain("installed Podman with slirp4netns")
		const after = await factsOf(host, account)
		expect(after.podman?.major).toBe(4)
		expect(after.helpers).toContain("slirp4netns")
		expect(after.subuid.own && after.subgid.own).toBe(true)
		expect(
			succeeded(
				await shell(host, ROOT, 'grep -h "^$1:" /etc/subuid /etc/subgid', account),
				"reading the account's ranges",
			),
		).toBe(`${account}:${range.start}:65536\n${account}:${range.start}:65536\n`)
		expect(await lingers(host, account)).toBe(true)
	})
})

describe("the host setup script, when a package it would install conflicts with one already there", () => {
	let host = ""

	beforeAll(async () => {
		host = await startHost(inject("sandbox"))
	})

	afterAll(async () => {
		await remove(host)
	})

	const installed = async (): Promise<string> =>
		succeeded(
			await shell(host, ROOT, "dpkg -l | awk '$1 == \"ii\" {print $2}' | sort"),
			"listing installed packages",
		)

	it("stops at apt-get, which removes nothing because of --no-remove", async () => {
		succeeded(
			await shell(
				host,
				ROOT,
				[
					"set -eu",
					"work=$(mktemp -d)",
					'mkdir -p "$work/pkg/DEBIAN"',
					"printf 'Package: open-mcc-conflict\\nVersion: 1.0\\nArchitecture: all\\nMaintainer: sandbox <sandbox@example.invalid>\\nConflicts: catatonit\\nDescription: conflicts with catatonit\\n' > \"$work/pkg/DEBIAN/control\"",
					'dpkg-deb --build "$work/pkg" "$work/open-mcc-conflict.deb" >/dev/null',
					'dpkg -i "$work/open-mcc-conflict.deb" >/dev/null',
				].join("\n"),
			),
			"installing a package that conflicts with catatonit",
		)
		const account = await newAccount(host)
		const key = await mintKey(host)
		const before = await installed()
		expect(before).toContain("open-mcc-conflict\n")

		const ran = await setUp(host, account, key.publicKey)

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain("Could not install Podman")
		expect(ran.stderr).toContain("remove is disabled")
		expect(await installed()).toBe(before)
		expect(await hasPodman(host)).toBe(false)
	})
})

describe("the commands the host check shows, run as written on a plain host", () => {
	let host = ""

	beforeAll(async () => {
		host = await startHost(inject("sandbox"))
	})

	afterAll(async () => {
		await remove(host)
	})

	it("fixes every missing prerequisite it has a command for", async () => {
		const account = await accountWithoutSubordinateIds(host)
		succeeded(
			await exec(host, { ...ROOT, timeoutMs: INSTALL_TIMEOUT_MS }, ["apt-get", "update", "-qq"]),
			"refreshing the package lists this image leaves out",
		)
		const before = await factsOf(host, account)
		expect(before.podman).toBeNull()
		expect(before.subuid.own || before.subgid.own).toBe(false)
		expect(await lingers(host, account)).toBe(false)

		const commands = [
			lingerCommand(account),
			PODMAN_INSTALL_COMMAND,
			networkHelperCommand("slirp4netns"),
			networkHelperCommand("pasta"),
			subordinateIdsCommand(
				nextSubordinateRange(before.subuid.ranges, before.subgid.ranges),
				account,
			),
		]
		for (const command of commands) {
			const ran = await shell(host, { user: "tester", timeoutMs: INSTALL_TIMEOUT_MS }, command)

			expect(ran.status, `${command}\n${ran.stderr}`).toBe(0)
		}

		const after = await factsOf(host, account)
		expect(after.podman?.major).toBe(4)
		expect(after.helpers).toEqual(["slirp4netns", "pasta"])
		expect(after.subuid.own && after.subgid.own).toBe(true)
		expect(await lingers(host, account)).toBe(true)
	})
})

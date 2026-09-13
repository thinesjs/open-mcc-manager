import { setTimeout as delay } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { hostSetupScript } from "../../apps/web/src/lib/host-setup"
import {
	exec,
	homeOf,
	mintKey,
	newAccount,
	ROOT,
	read,
	remove,
	shell,
	signIn,
	snapshot,
	startHost,
	succeeded,
} from "./sandbox"

type Mode = Parameters<typeof hostSetupScript>[0]

const setUp = (host: string, mode: Mode, account: string, publicKey: string) =>
	shell(host, { user: "tester" }, hostSetupScript(mode, account, publicKey))

const authorizedKeysOf = (account: string): string => `${homeOf(account)}/.ssh/authorized_keys`

const accountFor = async (host: string, mode: Mode): Promise<string> => {
	if (mode === "rootless") return await newAccount(host)
	succeeded(await exec(host, ROOT, ["rm", "-rf", "/root/.ssh"]), "clearing root's ssh directory")
	return "root"
}

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

describe.each([{ mode: "rootless" }, { mode: "system" }] as const)(
	"the host setup script, in $mode mode",
	({ mode }) => {
		let host = ""

		beforeAll(async () => {
			host = await startHost(inject("sandboxRun"))
		})

		afterAll(async () => {
			await remove(host)
		})

		it("authorises the key for that account alone, with the modes sshd insists on", async () => {
			const account = await accountFor(host, mode)
			const key = await mintKey(host)

			const ran = await setUp(host, mode, account, key.publicKey)

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
			const account = await accountFor(host, mode)
			const key = await mintKey(host)

			expect((await setUp(host, mode, account, key.publicKey)).status).toBe(0)

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
			const account = await accountFor(host, mode)
			const key = await mintKey(host)

			expect((await setUp(host, mode, account, key.publicKey)).status).toBe(0)
			const once = await read(host, authorizedKeysOf(account))
			expect((await setUp(host, mode, account, key.publicKey)).status).toBe(0)

			expect(await read(host, authorizedKeysOf(account))).toBe(once)
			expect(once).toBe(`${key.publicKey}\n`)
		})

		it("refuses an account that does not exist, having changed nothing", async () => {
			const key = await mintKey(host)
			const watched = ["/home", "/root", "/.ssh", "/var/lib/systemd/linger"]
			const before = await snapshot(host, ...watched)

			const ran = await setUp(host, mode, "nobody-by-that-name", key.publicKey)

			expect(ran.status).not.toBe(0)
			expect(ran.stderr).toContain("There is no account called nobody-by-that-name")
			expect(await snapshot(host, ...watched)).toBe(before)
		})

		it("prints the fingerprint of the host key this machine's sshd presents", async () => {
			const account = await accountFor(host, mode)
			const key = await mintKey(host)

			const ran = await setUp(host, mode, account, key.publicKey)

			const presented = await presentedFingerprint(host)
			expect(presented).toMatch(/^SHA256:/)
			expect(ran.stdout.trim().split("\n").at(-1)).toBe(presented)
		})

		it(
			mode === "rootless"
				? "turns lingering on, so the account's systemd runs with nobody logged in"
				: "leaves lingering off, which a root-owned host does not use",
			async () => {
				const account = await accountFor(host, mode)
				const key = await mintKey(host)
				expect(await lingers(host, account)).toBe(false)

				expect((await setUp(host, mode, account, key.publicKey)).status).toBe(0)

				expect(await lingers(host, account)).toBe(mode === "rootless")
				if (mode === "rootless") expect(await userManagerOf(host, account)).toBe("active")
			},
		)
	},
)

describe("the host setup script, on a machine with no libicu", () => {
	let host = ""

	beforeAll(async () => {
		host = await startHost(inject("sandboxRun"))
	})

	afterAll(async () => {
		await remove(host)
	})

	const hasLibicu = async (): Promise<boolean> =>
		succeeded(await exec(host, ROOT, ["ldconfig", "-p"]), "listing libraries").includes("libicuuc")

	it("installs it from the distribution's own packages", async () => {
		expect(await hasLibicu()).toBe(false)
		const account = await newAccount(host)
		const key = await mintKey(host)

		const ran = await setUp(host, "rootless", account, key.publicKey)

		expect(ran.status, ran.stderr).toBe(0)
		expect(await hasLibicu()).toBe(true)
	})
})

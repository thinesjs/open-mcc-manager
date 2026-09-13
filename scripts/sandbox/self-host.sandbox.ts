import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import {
	docker,
	exec,
	mintKey,
	newAccount,
	type Ran,
	REPOSITORY,
	ROOT,
	read,
	remove,
	SSH_CLIENT,
	seedAuthorizedKeys,
	shell,
	signIn,
	snapshot,
	startHost,
	succeeded,
} from "./sandbox"

const SCRIPT = "/opt/open-mcc/self-host.sh"

let host = ""

beforeAll(async () => {
	host = await startHost(inject("sandboxRun"))
	succeeded(await exec(host, ROOT, ["mkdir", "-p", "/opt/open-mcc"]), "making room for the script")
	succeeded(
		await docker(["cp", join(REPOSITORY, "scripts", "self-host.sh"), `${host}:${SCRIPT}`]),
		"copying the script in",
	)
})

afterAll(async () => {
	await remove(host)
})

const selfHost = (account: string, args: readonly string[] = [], input = ""): Promise<Ran> =>
	exec(host, { user: account, workdir: `/home/${account}`, input }, ["sh", SCRIPT, ...args])

const mintedKeyOf = (account: string): string => `/home/${account}/.ssh/open-mcc-self-host`

const materialsOf = async (account: string): Promise<Map<string, string>> => {
	const text = await read(host, `/home/${account}/.env.self-host`)
	return new Map(
		text
			.split("\n")
			.filter((line) => /^[A-Z_]+=/.test(line))
			.map(
				(line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const,
			),
	)
}

const FORWARD = `key="$1"; target="$2"; port="$3"
ssh -i "$key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \\
	-o UserKnownHostsFile=/dev/null -o LogLevel=INFO -N -L "127.0.0.1:$port:$target:22" \\
	"$(id -un)@127.0.0.1" 2>"/tmp/forward-$port.log" &
tunnel=$!
tries=0
until bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null || [ "$tries" -ge 50 ]; do
	tries=$((tries + 1))
	sleep 0.1
done
banner="$(timeout 5 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port; head -c 7 <&3" 2>/dev/null || true)"
sleep 0.5
kill "$tunnel" 2>/dev/null
wait "$tunnel" 2>/dev/null
printf 'banner=%s\\n' "$banner"
cat "/tmp/forward-$port.log"`

const forward = async (
	account: string,
	target: string,
): Promise<{ banner: string; log: string }> => {
	const port = String(20_000 + Math.floor(Math.random() * 10_000))
	const ran = await exec(host, { user: account }, [
		"bash",
		"-c",
		FORWARD,
		"forward",
		mintedKeyOf(account),
		target,
		port,
	])
	const banner = ran.stdout.split("\n").find((line) => line.startsWith("banner=")) ?? ""
	return { banner: banner.slice("banner=".length), log: ran.stdout }
}

describe("self-host.sh, after a run that minted its own key", () => {
	let account = ""
	let first: Ran = { status: null, stdout: "", stderr: "" }

	beforeAll(async () => {
		account = await newAccount(host)
		first = await selfHost(account)
	})

	it("finishes, and reports the address unproven when there is no docker to prove it from", async () => {
		expect(first.status, first.stderr).toBe(0)
		expect(first.stderr).toContain("docker was not found")
		const materials = await materialsOf(account)
		expect(materials.get("SELF_HOST_USERNAME")).toBe(account)
		expect(materials.get("SELF_HOST_REACH")).toBe("unproven")
		expect(materials.get("SELF_HOST_HOSTNAME")).toBe("")
	})

	it("installs an entry that signs in as this account", async () => {
		const signedIn = await signIn(host, { user: account }, mintedKeyOf(account), account, "id -un")

		expect(signedIn.stdout.trim()).toBe(account)
	})

	it("gives that key no shell when it names no command", async () => {
		const refused = await signIn(host, { user: account }, mintedKeyOf(account), account)

		expect(refused.status).not.toBe(0)
		expect(refused.stderr).toContain("it has no interactive shell")
	})

	it("gives that key no terminal", async () => {
		const terminal = await exec(host, { user: account }, [
			"ssh",
			"-tt",
			"-i",
			mintedKeyOf(account),
			...SSH_CLIENT,
			`${account}@127.0.0.1`,
			"tty",
		])

		expect(terminal.stdout).not.toContain("/dev/pts")
		expect(terminal.stderr).toContain("PTY allocation request failed")
	})

	it("forwards to this machine's own loopback and nowhere else", async () => {
		const address = succeeded(await exec(host, ROOT, ["hostname", "-I"]), "reading an address")
			.trim()
			.split(" ")[0]
		expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
		expect(address).not.toMatch(/^127\./)
		const direct = await shell(
			host,
			ROOT,
			'timeout 5 bash -c "exec 3<>/dev/tcp/$1/22; head -c 7 <&3"',
			address ?? "",
		)
		expect(direct.stdout).toBe("SSH-2.0")

		const loopback = await forward(account, "127.0.0.1")
		const elsewhere = await forward(account, address ?? "")

		expect(loopback.banner).toBe("SSH-2.0")
		expect(elsewhere.banner).toBe("")
		expect(elsewhere.log).toContain("administratively prohibited")
	})

	it("changes nothing when it runs again", async () => {
		const before = await snapshot(host, `/home/${account}`)

		const again = await selfHost(account)

		expect(again.status, again.stderr).toBe(0)
		expect(await snapshot(host, `/home/${account}`)).toBe(before)
	})
})

describe("self-host.sh, on an account that already has authorized_keys", () => {
	it("keeps what was there, down to a last line with no newline, and that key still signs in", async () => {
		const account = await newAccount(host)
		const other = await mintKey(host)
		await seedAuthorizedKeys(host, account, other.publicKey)

		const ran = await selfHost(account)

		expect(ran.status, ran.stderr).toBe(0)
		const lines = (await read(host, `/home/${account}/.ssh/authorized_keys`)).split("\n")
		expect(lines).toHaveLength(3)
		expect(lines[0]).toBe(other.publicKey)
		expect(lines[1]).toMatch(/^restrict,port-forwarding,permitopen="127\.0\.0\.1:\*",command=/)
		expect(lines[2]).toBe("")
		const signedIn = await signIn(host, ROOT, other.path, account, "id -un")
		expect(signedIn.stdout.trim()).toBe(account)
	})

	it("writes nothing when it stops before adding the entry", async () => {
		const account = await newAccount(host)
		const other = await mintKey(host)
		await seedAuthorizedKeys(host, account, `${other.publicKey}\n`)
		const before = await snapshot(host, `/home/${account}`)

		const ran = await selfHost(account, ["--public-key", "-"], "this is not a key\n")

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain("does not read as an ssh public key")
		expect(await snapshot(host, `/home/${account}`)).toBe(before)
	})
})

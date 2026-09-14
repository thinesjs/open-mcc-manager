import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import {
	exec,
	homeOf,
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
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

const PROVING = "/opt/stand-in"
const MEDDLING = "/opt/stand-in-meddling"
const RACE = "/opt/stand-in-race"
const FAILING_AWK = "/opt/stand-in-awk"
const HALF_MINTING = "/opt/stand-in-keygen"

const STAND_INS = [
	[
		`${PROVING}/docker`,
		`#!/bin/sh
case "$1" in
	image) exit 0 ;;
	run)
		cat >/dev/null
		printf 'ADDRESS=host.docker.internal\\nAUTH=ok\\nFORWARDS=yes\\n'
		;;
	*) exit 1 ;;
esac
`,
	],
	[
		`${MEDDLING}/docker`,
		`#!/bin/sh
case "$1" in
	image) exit 0 ;;
	run)
		cat >/dev/null
		keys="$HOME/.ssh/authorized_keys"
		grep -vF -- "$(cat ${MEDDLING}/revoked)" "$keys" > "$keys.meddled" || true
		cat ${MEDDLING}/added >> "$keys.meddled"
		cat "$keys.meddled" > "$keys"
		rm -f "$keys.meddled"
		;;
	*) exit 1 ;;
esac
`,
	],
	[
		`${RACE}/tail`,
		`#!/bin/sh
for each in "$@"; do
	file="$each"
done
if [ -f "${RACE}/added" ] && [ -n "$file" ] && [ -f "$file" ]; then
	added="$(cat "${RACE}/added")"
	grep -qxF -- "$added" "$file" 2>/dev/null || printf '%s\\n' "$added" >> "$file"
fi
exec /usr/bin/tail "$@"
`,
	],
	[
		`${FAILING_AWK}/awk`,
		`#!/bin/sh
for each in "$@"; do
	case "$each" in
		blob=*)
			printf '0 0\\n'
			exit 2
			;;
	esac
done
exec /usr/bin/awk "$@"
`,
	],
	[
		`${HALF_MINTING}/ssh-keygen`,
		`#!/bin/sh
previous=""
for each in "$@"; do
	if [ "$previous" = "-f" ]; then
		printf 'half of a key\\n' > "$each"
		exit 1
	fi
	previous="$each"
done
exec /usr/bin/ssh-keygen "$@"
`,
	],
] as const

const PROVEN = [PROVING] as const

let host = ""

beforeAll(async () => {
	host = await startHost(inject("sandbox"))
	succeeded(
		await shell(
			host,
			{ ...ROOT, input: readFileSync(join(REPOSITORY, "scripts", "self-host.sh")) },
			'mkdir -p "$(dirname "$1")" && cat > "$1"',
			SCRIPT,
		),
		"copying the script in",
	)
	for (const [path, text] of STAND_INS) {
		succeeded(
			await shell(
				host,
				{ ...ROOT, input: text },
				'mkdir -p "$(dirname "$1")" && cat > "$1" && chmod 755 "$1"',
				path,
			),
			`installing the stand-in ${path}`,
		)
	}
})

afterAll(async () => {
	await remove(host)
})

type Invocation = { args?: readonly string[]; input?: string; standIns?: readonly string[] }

const selfHost = (
	account: string,
	{ args = [], input = "", standIns = [] }: Invocation = {},
): Promise<Ran> =>
	exec(
		host,
		{
			user: account,
			workdir: homeOf(account),
			input,
			...(standIns.length === 0
				? {}
				: {
						env: {
							PATH: [...standIns, SYSTEM_PATH].join(":"),
							OPEN_MCC_IMAGE: "open-mcc-server",
						},
					}),
		},
		["sh", SCRIPT, ...args],
	)

const mintedKeyOf = (account: string): string => `${homeOf(account)}/.ssh/open-mcc-self-host`

const authorizedKeysOf = (account: string): string => `${homeOf(account)}/.ssh/authorized_keys`

const materialsOf = async (account: string): Promise<Map<string, string>> => {
	const text = await read(host, `${homeOf(account)}/.env.self-host`)
	return new Map(
		text
			.split("\n")
			.filter((line) => /^[A-Z_]+=/.test(line))
			.map(
				(line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const,
			),
	)
}

const restrictedEntry = (account: string, publicKey: string): string =>
	`restrict,port-forwarding,permitopen="127.0.0.1:*",command="'${homeOf(account)}/.ssh/open-mcc-self-host-command'" ${publicKey}`

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

describe("self-host.sh, after a run that proved an address and minted its own key", () => {
	let account = ""
	let first: Ran = { status: null, stdout: "", stderr: "" }

	beforeAll(async () => {
		account = await newAccount(host)
		first = await selfHost(account, { standIns: PROVEN })
	})

	it("finishes, and writes materials naming this account and the address it proved", async () => {
		expect(first.status, first.stderr).toBe(0)
		const materials = await materialsOf(account)
		expect(materials.get("SELF_HOST_USERNAME")).toBe(account)
		expect(materials.get("SELF_HOST_MODE")).toBe("rootless")
		expect(materials.get("SELF_HOST_HOSTNAME")).toBe("host.docker.internal")
		expect(materials.get("SELF_HOST_REACH")).toBe("proven")
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
		const before = await snapshot(host, homeOf(account))

		const again = await selfHost(account, { standIns: PROVEN })

		expect(again.status, again.stderr).toBe(0)
		expect(await snapshot(host, homeOf(account))).toBe(before)
	})
})

describe("self-host.sh, on an account that already has authorized_keys", () => {
	it("keeps what was there, down to a last line with no newline, and that key still signs in", async () => {
		const account = await newAccount(host)
		const other = await mintKey(host)
		await seedAuthorizedKeys(host, account, other.publicKey)

		const ran = await selfHost(account, { standIns: PROVEN })

		expect(ran.status, ran.stderr).toBe(0)
		const lines = (await read(host, authorizedKeysOf(account))).split("\n")
		expect(lines).toHaveLength(3)
		expect(lines[0]).toBe(other.publicKey)
		expect(lines[1]).toMatch(/^restrict,port-forwarding,permitopen="127\.0\.0\.1:\*",command=/)
		expect(lines[2]).toBe("")
		const signedIn = await signIn(host, ROOT, other.path, account, "id -un")
		expect(signedIn.stdout.trim()).toBe(account)
		const kept = await exec(host, ROOT, ["ls", "-A", `${homeOf(account)}/.ssh`])
		expect(kept.stdout.trim().split("\n")).toEqual([
			"authorized_keys",
			"open-mcc-self-host",
			"open-mcc-self-host-command",
			"open-mcc-self-host.pub",
		])
	})

	it("writes nothing when it stops before adding the entry", async () => {
		const account = await newAccount(host)
		const other = await mintKey(host)
		await seedAuthorizedKeys(host, account, `${other.publicKey}\n`)
		const before = await snapshot(host, homeOf(account))

		const ran = await selfHost(account, {
			args: ["--public-key", "-"],
			input: "this is not a key\n",
			standIns: PROVEN,
		})

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain("does not read as an ssh public key")
		expect(await snapshot(host, homeOf(account))).toBe(before)
	})

	it.each([
		{
			shape: "under other options",
			lines: (_account: string, publicKey: string) => [`no-pty ${publicKey}`],
		},
		{
			shape: "restricted, and again with no restrictions at all",
			lines: (account: string, publicKey: string) => [
				restrictedEntry(account, publicKey),
				publicKey,
			],
		},
	])("stops, having written nothing, when it already holds the key $shape", async ({ lines }) => {
		const account = await newAccount(host)
		const key = await mintKey(host)
		await seedAuthorizedKeys(host, account, `${lines(account, key.publicKey).join("\n")}\n`)
		const before = await snapshot(host, homeOf(account))

		const ran = await selfHost(account, {
			args: ["--public-key", "-"],
			input: `${key.publicKey}\n`,
			standIns: PROVEN,
		})

		expect(ran.status).not.toBe(0)
		expect(await snapshot(host, homeOf(account))).toBe(before)
	})

	it("treats a commented-out copy of the key as absent, and adds its entry after it", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)
		const revokedByHand = `# ${restrictedEntry(account, key.publicKey)}`
		await seedAuthorizedKeys(host, account, `${revokedByHand}\n`)

		const ran = await selfHost(account, {
			args: ["--public-key", "-"],
			input: `${key.publicKey}\n`,
			standIns: PROVEN,
		})

		expect(ran.status, ran.stderr).toBe(0)
		expect(await read(host, authorizedKeysOf(account))).toBe(
			`${revokedByHand}\n${restrictedEntry(account, key.publicKey)}\n`,
		)
	})

	it("stops, having written nothing, when it cannot finish checking what authorized_keys holds", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)
		await seedAuthorizedKeys(host, account, `${key.publicKey}\n`)
		const before = await snapshot(host, homeOf(account))

		const ran = await selfHost(account, {
			args: ["--public-key", "-"],
			input: `${key.publicKey}\n`,
			standIns: [FAILING_AWK, PROVING],
		})

		expect(ran.status).not.toBe(0)
		expect(await snapshot(host, homeOf(account))).toBe(before)
	})
})

describe("self-host.sh, given a public key to install", () => {
	it("refuses input holding more than one key, having written nothing", async () => {
		const account = await newAccount(host)
		const first = await mintKey(host)
		const second = await mintKey(host)
		await seedAuthorizedKeys(host, account, "")
		const before = await snapshot(host, homeOf(account))

		const ran = await selfHost(account, {
			args: ["--public-key", "-"],
			input: `${first.publicKey}\n${second.publicKey}\n`,
			standIns: PROVEN,
		})

		expect(ran.status).not.toBe(0)
		expect(await snapshot(host, homeOf(account))).toBe(before)
	})

	it("restricts a key that arrives between blank lines like any other", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)

		const ran = await selfHost(account, {
			args: ["--public-key", "-"],
			input: `\n${key.publicKey}\n\n`,
			standIns: PROVEN,
		})

		expect(ran.status, ran.stderr).toBe(0)
		const blob = key.publicKey.split(" ")[1] ?? ""
		const holding = (await read(host, authorizedKeysOf(account)))
			.split("\n")
			.filter((line) => line.length > 0)
		expect(holding).toEqual([restrictedEntry(account, key.publicKey)])
		expect(holding[0]).toContain(blob)
		expect((await materialsOf(account)).get("SELF_HOST_PUBLIC_KEY")).toBe(key.publicKey)
		const refused = await signIn(host, ROOT, key.path, account)
		expect(refused.stderr).toContain("it has no interactive shell")
	})
})

describe("self-host.sh, where a key file is already there or cannot be made", () => {
	it("refuses a .pub with no private key beside it, having written nothing", async () => {
		const account = await newAccount(host)
		const orphan = await mintKey(host)
		succeeded(
			await shell(
				host,
				{ user: account },
				'mkdir -m 700 "$1/.ssh" && printf "%s\\n" "$2" > "$1/.ssh/open-mcc-self-host.pub"',
				homeOf(account),
				orphan.publicKey,
			),
			"leaving a .pub with no private key beside it",
		)
		const before = await snapshot(host, homeOf(account))

		const ran = await selfHost(account, { standIns: PROVEN })

		expect(ran.status).not.toBe(0)
		expect(await snapshot(host, homeOf(account))).toBe(before)
	})

	it("takes back a key it only half made", async () => {
		const account = await newAccount(host)
		const before = await snapshot(host, homeOf(account))

		const ran = await selfHost(account, { standIns: [HALF_MINTING, PROVING] })

		expect(ran.status).not.toBe(0)
		expect(await snapshot(host, homeOf(account))).toBe(before)
	})
})

describe("self-host.sh, when the key it minted cannot sign in", () => {
	it("takes back everything it wrote, leaving only the entry that was already there", async () => {
		const account = await newAccount(host)
		const other = await mintKey(host)
		await seedAuthorizedKeys(host, account, other.publicKey)
		succeeded(
			await shell(
				host,
				ROOT,
				[
					'printf "DenyUsers %s\\n" "$1" > "/etc/ssh/sshd_config.d/deny-$1.conf"',
					"systemctl reload ssh",
					"for attempt in $(seq 1 50); do",
					'	[ -n "$(ssh-keyscan -T 1 127.0.0.1 2>/dev/null)" ] && exit 0',
					"	sleep 0.1",
					"done",
					"exit 1",
				].join("\n"),
				account,
			),
			"turning the account away at sshd",
		)

		const ran = await selfHost(account, { standIns: PROVEN })

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain("did not authenticate")
		expect(await read(host, authorizedKeysOf(account))).toBe(`${other.publicKey}\n`)
		const left = await exec(host, ROOT, ["ls", "-A", `${homeOf(account)}/.ssh`])
		expect(left.stdout.trim().split("\n")).toEqual(["authorized_keys"])
	})
})

describe("self-host.sh, when the forced command lets a session through", () => {
	it("stops, taking back what it wrote, rather than report a key with no shell", async () => {
		const account = await newAccount(host)
		succeeded(
			await shell(
				host,
				{
					user: account,
					input: '#!/bin/sh\nexec /bin/sh -c "${SSH_ORIGINAL_COMMAND:-true}"\n',
				},
				'mkdir -m 700 "$1/.ssh" && cat > "$1/.ssh/open-mcc-self-host-command" && chmod 700 "$1/.ssh/open-mcc-self-host-command"',
				homeOf(account),
			),
			"leaving a forced command that does not refuse",
		)
		const before = await snapshot(host, homeOf(account))

		const ran = await selfHost(account, { standIns: PROVEN })

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain("forced command")
		expect(await snapshot(host, homeOf(account))).toBe(before)
	})
})

describe("self-host.sh, when authorized_keys changes while it runs", () => {
	it("takes back only its own entry, keeping what changed meanwhile", async () => {
		const account = await newAccount(host)
		const kept = await mintKey(host)
		const revoked = await mintKey(host)
		const added = await mintKey(host)
		await seedAuthorizedKeys(host, account, `${kept.publicKey}\n${revoked.publicKey}\n`)
		succeeded(
			await shell(
				host,
				ROOT,
				'printf "%s\\n" "$2" > "$1/revoked" && printf "%s\\n" "$3" > "$1/added" && chmod 644 "$1/revoked" "$1/added"',
				MEDDLING,
				revoked.publicKey,
				added.publicKey,
			),
			"telling the stand-in what to change",
		)

		const ran = await selfHost(account, { standIns: [MEDDLING] })

		expect(ran.status).not.toBe(0)
		expect(await read(host, authorizedKeysOf(account))).toBe(
			`${kept.publicKey}\n${added.publicKey}\n`,
		)
		const left = await exec(host, ROOT, ["ls", "-A", `${homeOf(account)}/.ssh`])
		expect(left.stdout.trim().split("\n")).toEqual(["authorized_keys"])
	})
})

describe("self-host.sh, when an earlier run left an identical entry behind", () => {
	it("removes only the copy this run added, leaving the earlier one in place", async () => {
		const account = await newAccount(host)
		const kept = await mintKey(host)
		const key = await mintKey(host)
		const duplicate = restrictedEntry(account, key.publicKey)
		await seedAuthorizedKeys(host, account, `${kept.publicKey}\n`)
		succeeded(
			await shell(
				host,
				ROOT,
				'printf "%s\\n" "$2" > "$1/added" && chmod 644 "$1/added"',
				RACE,
				duplicate,
			),
			"telling the stand-in what to duplicate",
		)

		const ran = await selfHost(account, {
			args: ["--public-key", "-"],
			input: `${key.publicKey}\n`,
			standIns: [RACE],
		})

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain("docker was not found")
		expect(await read(host, authorizedKeysOf(account))).toBe(
			`${kept.publicKey}\n${duplicate}\n`,
		)
	})
})

describe("self-host.sh, when it finds its own entry already listed", () => {
	it("removes nothing on rollback, because this run wrote nothing to authorized_keys", async () => {
		const account = await newAccount(host)
		const key = await mintKey(host)
		const existing = restrictedEntry(account, key.publicKey)
		await seedAuthorizedKeys(host, account, `${existing}\n`)

		const ran = await selfHost(account, {
			args: ["--public-key", "-"],
			input: `${key.publicKey}\n`,
		})

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain("docker was not found")
		expect(await read(host, authorizedKeysOf(account))).toBe(`${existing}\n`)
	})
})

describe("self-host.sh, when a key arrives while it is still writing its own entry", () => {
	it("keeps that key on rollback instead of restoring the file from before this ran", async () => {
		const account = await newAccount(host)
		const kept = await mintKey(host)
		const added = await mintKey(host)
		await seedAuthorizedKeys(host, account, `${kept.publicKey}\n`)
		succeeded(
			await shell(
				host,
				ROOT,
				'printf "%s\\n" "$2" > "$1/added" && chmod 644 "$1/added"',
				RACE,
				added.publicKey,
			),
			"telling the stand-in what to add",
		)

		const ran = await selfHost(account, { standIns: [RACE] })

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain("docker was not found")
		expect(await read(host, authorizedKeysOf(account))).toBe(
			`${kept.publicKey}\n${added.publicKey}\n`,
		)
		const left = await exec(host, ROOT, ["ls", "-A", `${homeOf(account)}/.ssh`])
		expect(left.stdout.trim().split("\n")).toEqual(["authorized_keys"])
	})
})

describe("self-host.sh, run as root", () => {
	it("refuses, leaving root's authorized_keys as it was and writing no materials", async () => {
		const other = await mintKey(host)
		await seedAuthorizedKeys(host, "root", `${other.publicKey}\n`)
		const before = await snapshot(host, "/root/.ssh", "/root/.env.self-host")

		const ran = await selfHost("root", { standIns: PROVEN })

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain("not as root")
		expect(await snapshot(host, "/root/.ssh", "/root/.env.self-host")).toBe(before)
	})
})

describe("self-host.sh, where nothing can prove an address", () => {
	it("stops, having written nothing, when there is no docker to prove one from", async () => {
		const account = await newAccount(host)
		const before = await snapshot(host, homeOf(account))

		const ran = await selfHost(account)

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain("docker was not found")
		expect(await snapshot(host, homeOf(account))).toBe(before)
	})
})

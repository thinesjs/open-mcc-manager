import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

declare module "vitest" {
	export interface ProvidedContext {
		sandboxRun: string
	}
}

export const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

export const SANDBOX_LABEL = "open-mcc.sandbox"
export const RUN_LABEL = "open-mcc.sandbox.run"
export const HOST_IMAGE = "open-mcc-sandbox:local"

export type Ran = { status: number | null; stdout: string; stderr: string }

export type RunOptions = { input?: string; timeoutMs?: number }

export type As = RunOptions & {
	user: string
	workdir?: string
	env?: Readonly<Record<string, string>>
}

export const ROOT: As = { user: "root" }

export const run = (
	command: string,
	args: readonly string[],
	options: RunOptions = {},
): Promise<Ran> =>
	new Promise((resolve, reject) => {
		const timeoutMs = options.timeoutMs ?? 120_000
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			reject(new Error(`${command} ${args[0] ?? ""} did not finish within ${timeoutMs}ms`))
		}, timeoutMs)
		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk
		})
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk
		})
		child.stdin.on("error", () => undefined)
		child.on("error", (error) => {
			clearTimeout(timer)
			reject(error)
		})
		child.on("close", (status) => {
			clearTimeout(timer)
			resolve({ status, stdout, stderr })
		})
		child.stdin.end(options.input ?? "")
	})

const REACHES_THIS_MACHINE = /^(?:-v|--volume(?:=|$)|--mount|--volumes-from)|docker\.sock/

export const reachesThisMachine = (args: readonly string[]): boolean =>
	args.some((each) => REACHES_THIS_MACHINE.test(each))

const FORCE = /^(?:--force|-[A-Za-z]*f[A-Za-z]*)$/

export const killsAContainer = (args: readonly string[]): boolean => {
	const plain = args[0] === "container" ? args.slice(1) : args
	switch (plain[0]) {
		case "kill":
			return true
		case "rm":
			return plain.some((each) => FORCE.test(each))
		case "stop":
			return plain[1] !== "--timeout" || plain[2] !== "-1"
		default:
			return false
	}
}

export const docker = (args: readonly string[], options: RunOptions = {}): Promise<Ran> => {
	if (reachesThisMachine(args)) {
		return Promise.reject(
			new Error("a sandbox container may not see this machine's files or its Docker socket"),
		)
	}
	if (killsAContainer(args)) {
		return Promise.reject(
			new Error("a sandbox container is only stopped by its own shutdown, never killed or forced"),
		)
	}
	return run("docker", args, options)
}

export const succeeded = (ran: Ran, what: string): string => {
	if (ran.status === 0) return ran.stdout
	throw new Error(`${what} exited ${ran.status}: ${(ran.stderr || ran.stdout).trim()}`)
}

const labelled = (runId: string, kind: string): readonly string[] => [
	"--label",
	`${SANDBOX_LABEL}=${kind}`,
	"--label",
	`${RUN_LABEL}=${runId}`,
]

export const hostRunArguments = (name: string, runId: string): readonly string[] => [
	"run",
	"--detach",
	"--name",
	name,
	...labelled(runId, "host"),
	"--privileged",
	"--cgroupns=private",
	"--tmpfs",
	"/run",
	"--tmpfs",
	"/run/lock",
	HOST_IMAGE,
]

const nameFor = (runId: string, kind: string): string =>
	`open-mcc-sandbox-${runId}-${kind}-${randomUUID().slice(0, 8)}`

const SETTLED = new Set(["running", "degraded", "maintenance", "stopping", "offline"])

export const startHost = async (runId: string): Promise<string> => {
	const name = nameFor(runId, "host")
	succeeded(await docker(hostRunArguments(name, runId)), "starting a sandbox host")
	let state = ""
	for (let attempt = 0; attempt < 360 && !SETTLED.has(state); attempt += 1) {
		if (attempt > 0) await delay(500)
		state = (await docker(["exec", name, "systemctl", "is-system-running"])).stdout.trim()
	}
	if (state === "running") return name
	const failed = await docker(["exec", name, "systemctl", "--failed", "--no-legend"])
	throw new Error(`the sandbox host came up ${state || "not at all"}: ${failed.stdout.trim()}`)
}

export const STOP_WITHOUT_KILLING = ["stop", "--timeout", "-1"] as const

export const remove = async (...names: readonly string[]): Promise<void> => {
	const present = names.filter((name) => name.length > 0)
	if (present.length === 0) return
	const stopped = await docker([...STOP_WITHOUT_KILLING, ...present], {
		timeoutMs: 120_000,
	}).catch(() => undefined)
	if (stopped?.status !== 0) {
		throw new Error(
			`these sandbox containers did not shut down, and are left for a person to remove: ${present.join(" ")}`,
		)
	}
	succeeded(await docker(["rm", "--volumes", ...present]), `removing ${present.join(" ")}`)
}

export const removeRun = async (runId: string): Promise<void> => {
	const listed = succeeded(
		await docker(["ps", "--all", "--quiet", "--filter", `label=${RUN_LABEL}=${runId}`]),
		"listing this run's sandbox containers",
	)
	await remove(...listed.split("\n"))
}

export const exec = (container: string, as: As, argv: readonly string[]): Promise<Ran> =>
	docker(
		[
			"exec",
			"--interactive",
			"--user",
			as.user,
			...(as.workdir === undefined ? [] : ["--workdir", as.workdir]),
			...Object.entries(as.env ?? {}).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
			container,
			...argv,
		],
		as,
	)

export const shell = (
	container: string,
	as: As,
	script: string,
	...args: readonly string[]
): Promise<Ran> => exec(container, as, ["sh", "-c", script, "sh", ...args])

export const read = async (container: string, path: string): Promise<string> =>
	succeeded(await exec(container, ROOT, ["cat", path]), `reading ${path}`)

export const homeOf = (account: string): string =>
	account === "root" ? "/root" : `/home/${account}`

export const newAccount = async (container: string): Promise<string> => {
	const account = `u${randomUUID().slice(0, 8)}`
	succeeded(
		await exec(container, ROOT, ["useradd", "--create-home", "--shell", "/bin/bash", account]),
		"adding an account",
	)
	return account
}

export type Key = { path: string; publicKey: string }

export const mintKey = async (container: string): Promise<Key> => {
	const path = `/root/keys/${randomUUID().slice(0, 8)}`
	succeeded(
		await shell(
			container,
			ROOT,
			'mkdir -p /root/keys && ssh-keygen -q -t ed25519 -N "" -C sandbox -f "$1"',
			path,
		),
		"minting a key",
	)
	return { path, publicKey: (await read(container, `${path}.pub`)).trim() }
}

export const seedAuthorizedKeys = async (
	container: string,
	account: string,
	content: string,
): Promise<void> => {
	succeeded(
		await shell(
			container,
			{ ...ROOT, input: content },
			[
				'home="$(getent passwd "$1" | cut -d: -f6)"',
				'install -d -m 700 -o "$1" -g "$(id -gn "$1")" "$home/.ssh"',
				'cat > "$home/.ssh/authorized_keys"',
				'chown "$1:" "$home/.ssh/authorized_keys"',
				'chmod 600 "$home/.ssh/authorized_keys"',
			].join("\n"),
			account,
		),
		"seeding authorized_keys",
	)
}

export const SSH_CLIENT = [
	"-o",
	"BatchMode=yes",
	"-o",
	"IdentitiesOnly=yes",
	"-o",
	"StrictHostKeyChecking=no",
	"-o",
	"UserKnownHostsFile=/dev/null",
] as const

export const signIn = (
	container: string,
	as: As,
	key: string,
	account: string,
	...command: readonly string[]
): Promise<Ran> =>
	exec(container, as, ["ssh", "-i", key, ...SSH_CLIENT, `${account}@127.0.0.1`, ...command])

const SNAPSHOT = `for path in "$@"; do
	if [ -e "$path" ]; then
		find "$path" -printf '%y %m %u:%g %s %p\\n' | sort
		find "$path" -type f -exec sha256sum {} + | sort
	else
		echo "absent $path"
	fi
done`

export const snapshot = async (container: string, ...paths: readonly string[]): Promise<string> =>
	succeeded(await shell(container, ROOT, SNAPSHOT, ...paths), "taking a snapshot")

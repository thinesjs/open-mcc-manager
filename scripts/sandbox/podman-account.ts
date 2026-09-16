import { createFakeTransport } from "../../packages/transport/src/fake"
import {
	type As,
	buildImage,
	exec,
	ROOT,
	SANDBOX_PLATFORM,
	type Sandbox,
	shell,
	startHost,
	succeeded,
} from "./sandbox"

export const PODMAN_TARGETS = [
	{ name: "Debian 12", baseImage: "debian:bookworm-20250908", stack: "slirp4netns" },
	{ name: "Debian 13", baseImage: "debian:trixie-20250908", stack: "pasta" },
	{ name: "Ubuntu 24.04", baseImage: "ubuntu:noble-20250910", stack: "slirp4netns" },
] as const

export type PodmanTarget = (typeof PODMAN_TARGETS)[number]

export const ACCOUNT = "pod1"

const UID = 2001

export const HOME = `/home/${ACCOUNT}`

export const startPodmanHost = async (sandbox: Sandbox, target: PodmanTarget): Promise<string> => {
	const image = await buildImage({
		target: "podman-host",
		baseImage: target.baseImage,
		platform: SANDBOX_PLATFORM,
	})
	return await startHost({ ...sandbox, image }, [
		`${HOME}/.local/share/containers:uid=${UID},gid=${UID},mode=0700`,
	])
}

export const withUserManager = async (host: string): Promise<As> => {
	succeeded(await exec(host, ROOT, ["loginctl", "enable-linger", ACCOUNT]), "turning lingering on")
	succeeded(
		await shell(
			host,
			ROOT,
			'for attempt in $(seq 300); do [ "$(systemctl is-active "user@$1.service")" = active ] && [ -S "/run/user/$1/bus" ] && exit 0; sleep 0.1; done; exit 1',
			String(UID),
		),
		"waiting for the account's systemd",
	)
	return {
		user: ACCOUNT,
		workdir: HOME,
		env: {
			XDG_RUNTIME_DIR: `/run/user/${UID}`,
			DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${UID}/bus`,
		},
	}
}

const NOFILE_DIAGNOSIS = [
	'echo "caller hard nofile: $(ulimit -H -n)"',
	'echo "fs.nr_open: $(timeout 5 cat /proc/sys/fs/nr_open)"',
	"echo \"user service hard nofile: $(timeout 5 systemd-run --user --wait --pipe --quiet sh -c 'ulimit -H -n' 2>&1 | head -n 1)\"",
	'timeout 5 podman --log-level=debug exec "$1" true 2>&1 | grep -i -E "rlimit|nofile" | head -n 5',
	"exit 0",
].join("\n")

export const nofileDiagnosis = async (host: string, as: As, container: string): Promise<string> =>
	await shell(host, { ...as, timeoutMs: 30_000 }, NOFILE_DIAGNOSIS, container).then(
		(ran) => ran.stdout.slice(0, 2000),
		(error) =>
			`diagnostic unavailable: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
	)

export const inContainer = async (
	host: string,
	as: As,
	container: string,
	what: string,
	command: readonly string[],
): Promise<string> => {
	const ran = await shell(
		host,
		{ ...as, timeoutMs: 60_000 },
		'systemd-run --user --wait --pipe --quiet podman exec "$@"',
		container,
		...command,
	)
	if (ran.status !== 0) {
		const failure = `${what} exited ${ran.status}: ${ran.stderr.trim().slice(0, 1000)}`
		throw new Error(`${failure}\n${await nofileDiagnosis(host, as, container)}`)
	}
	return ran.stdout
}

export const shellTransport = (host: string, as: As): ReturnType<typeof createFakeTransport> => {
	const transport = createFakeTransport()
	const run = async (command: string, timeoutMs?: number, stdin?: string) => {
		const ran = await shell(
			host,
			{
				...as,
				...(timeoutMs === undefined ? {} : { timeoutMs }),
				...(stdin === undefined ? {} : { input: stdin }),
			},
			command,
		)
		return { stdout: ran.stdout, stderr: ran.stderr, exitCode: ran.status ?? 255 }
	}
	transport.exec = run
	transport.execUntil = (command: string, signal: AbortSignal) =>
		new Promise((resolve, reject) => {
			const abandon = (): void =>
				reject(signal.reason instanceof Error ? signal.reason : new Error("abandoned"))
			if (signal.aborted) {
				abandon()
				return
			}
			signal.addEventListener("abort", abandon, { once: true })
			run(command).then(
				(result) => {
					signal.removeEventListener("abort", abandon)
					resolve(result)
				},
				(error) => {
					signal.removeEventListener("abort", abandon)
					reject(error instanceof Error ? error : new Error(String(error)))
				},
			)
		})
	return transport
}

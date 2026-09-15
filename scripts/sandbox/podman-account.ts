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
				(error: Error) => {
					signal.removeEventListener("abort", abandon)
					reject(error)
				},
			)
		})
	return transport
}

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import {
	HOST_FACTS_COMMAND,
	parseHostFacts,
	STORAGE_CONF,
	STORAGE_OVERRIDE_VARIABLES,
	storageStepCommand,
} from "../../packages/core/src/host/podman-facts"
import {
	type As,
	buildImage,
	exec,
	ROOT,
	remove,
	SANDBOX_PLATFORM,
	shell,
	startHost,
	succeeded,
} from "./sandbox"

const TARGETS = [
	{
		name: "Debian 12",
		baseImage: "debian:bookworm-20250908",
		osId: "debian",
		major: 4,
		stack: "slirp4netns",
		network: "slirp4netns:port_handler=slirp4netns",
	},
	{
		name: "Debian 13",
		baseImage: "debian:trixie-20250908",
		osId: "debian",
		major: 5,
		stack: "pasta",
		network: "pasta",
	},
	{
		name: "Ubuntu 24.04",
		baseImage: "ubuntu:noble-20250910",
		osId: "ubuntu",
		major: 4,
		stack: "slirp4netns",
		network: "slirp4netns:port_handler=slirp4netns",
	},
] as const

const ACCOUNTS = ["pod1", "pod2", "pod3", "pod4", "pod5", "pod6"] as const

type Account = (typeof ACCOUNTS)[number]

const uidOf = (account: Account): number => 2001 + ACCOUNTS.indexOf(account)

const CONTAINER_STORAGE = ACCOUNTS.map(
	(account) =>
		`/home/${account}/.local/share/containers:uid=${uidOf(account)},gid=${uidOf(account)},mode=0700`,
)

const BUSYBOX = "docker.io/library/busybox:1.36.1"

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

const STANDIN = [
	"echo standin-up",
	"while IFS= read -r line; do",
	'\techo "got:$line"',
	'\tcase "$line" in',
	"\t\t/exit3) exit 3 ;;",
	"\t\t/exit4) exit 4 ;;",
	"\t\t/quit) echo bye; exit 0 ;;",
	"\tesac",
	"done",
	"",
].join("\n")

const standinUnit = (network: string): string =>
	[
		"[Unit]",
		"Description=sandbox stand-in client %i",
		"StartLimitIntervalSec=0",
		"",
		"[Service]",
		"Type=notify",
		"NotifyAccess=all",
		"Delegate=yes",
		"WorkingDirectory=%h/standin/%i",
		"ExecStartPre=/bin/rm -f %t/standin-%i.ctr-id",
		`ExecStart=/bin/sh -c 'exec 3<>"%h/standin/%i/control"; exec /usr/bin/podman run --cidfile=%t/standin-%i.ctr-id --replace --rm -d -i --pull=never --sdnotify=conmon --cgroups=split --log-driver=passthrough --init --name standin-%i --user 0:0 --read-only --cap-drop=all --security-opt=no-new-privileges --network=${network} -v %h/standin/standin.sh:/standin.sh:ro ${BUSYBOX} sh /standin.sh <&3'`,
		`ExecStop=/bin/sh -c 'printf "/quit\\\\n" > "%h/standin/%i/control"; while kill -0 $$MAINPID 2>/dev/null; do sleep 0.2; done'`,
		"ExecStopPost=-/usr/bin/podman rm -f --ignore --cidfile=%t/standin-%i.ctr-id",
		"StandardOutput=journal",
		"StandardError=journal",
		"TimeoutStopSec=30",
		"Restart=on-failure",
		"RestartPreventExitStatus=4",
		"RestartSec=1",
		"",
	].join("\n")

const factsOf = async (host: string, as: As) =>
	parseHostFacts(succeeded(await shell(host, as, HOST_FACTS_COMMAND), "reading the host facts"))

const exists = async (host: string, path: string): Promise<boolean> =>
	(await exec(host, ROOT, ["test", "-e", path])).status === 0

const withUserManager = async (host: string, account: Account): Promise<As> => {
	const uid = uidOf(account)
	succeeded(await exec(host, ROOT, ["loginctl", "enable-linger", account]), "turning lingering on")
	succeeded(
		await shell(
			host,
			ROOT,
			'for attempt in $(seq 300); do [ "$(systemctl is-active "user@$1.service")" = active ] && [ -S "/run/user/$1/bus" ] && exit 0; sleep 0.1; done; exit 1',
			String(uid),
		),
		"waiting for the account's systemd",
	)
	return {
		user: account,
		workdir: `/home/${account}`,
		env: {
			XDG_RUNTIME_DIR: `/run/user/${uid}`,
			DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
		},
	}
}

const withEnv = (as: As, extra: Readonly<Record<string, string>>): As => ({
	...as,
	env: { ...as.env, ...extra },
})

describe.each(TARGETS)("a Podman host on $name", (target) => {
	let host = ""

	beforeAll(async () => {
		const image = await buildImage({
			target: "podman-host",
			baseImage: target.baseImage,
			platform: SANDBOX_PLATFORM,
		})
		host = await startHost({ ...inject("sandbox"), image }, CONTAINER_STORAGE)
	}, 2_400_000)

	afterAll(async () => {
		await remove(host)
	}, 300_000)

	it("reads every fact, podman --version among them, leaving no graph root and no runtime state", async () => {
		const as = await withUserManager(host, "pod1")
		const runtimeDir = `/run/user/${uidOf("pod1")}`

		succeeded(await exec(host, as, ["podman", "--version"]), "podman --version")
		const facts = await factsOf(host, as)

		expect(facts).toMatchObject({
			uid: uidOf("pod1"),
			usableHome: true,
			storage: "fresh",
			overrides: [],
			cgroupV2: true,
			metadata: "unanswered",
			subuid: { own: true },
			subgid: { own: true },
		})
		expect(facts.os.id).toBe(target.osId)
		expect(facts.podman?.major).toBe(target.major)
		expect(facts.helpers).toContain(target.stack)
		expect(await exists(host, "/home/pod1/.local/share/containers/storage")).toBe(false)
		expect(
			succeeded(
				await shell(
					host,
					ROOT,
					'find "$1/containers" "$1/libpod" -mindepth 1 2>/dev/null || true',
					runtimeDir,
				),
				"listing the account's Podman run root",
			).trim(),
		).toBe("")

		const setUp = await shell(host, as, storageStepCommand())

		expect(setUp.stdout.trim(), setUp.stderr).toBe("ready")
		expect(setUp.status).toBe(0)
	})

	it("sets up storage on a fresh account, after which Podman reports overlay", async () => {
		const as = await withUserManager(host, "pod2")

		const ran = await shell(host, as, storageStepCommand())

		expect(ran.stdout.trim(), ran.stderr).toBe("ready")
		expect(ran.status).toBe(0)
		expect(
			await exec(host, ROOT, ["cat", "/home/pod2/.config/containers/storage.conf"]),
		).toMatchObject({ stdout: STORAGE_CONF })
		expect(
			succeeded(
				await exec(host, as, [
					"podman",
					"info",
					"--format",
					"{{.Store.GraphDriverName}} {{.Host.Security.Rootless}}",
				]),
				"podman info",
			).trim(),
		).toBe("overlay true")
		expect((await factsOf(host, as)).storage).toBe("set-up")
	})

	it("refuses an account that already ran Podman with vfs, writing nothing", async () => {
		const as = await withUserManager(host, "pod3")
		succeeded(
			await exec(host, as, [
				"podman",
				"--storage-driver=vfs",
				"info",
				"--format",
				"{{.Store.GraphDriverName}}",
			]),
			"running Podman with vfs",
		)
		expect((await factsOf(host, as)).storage).toBe("used")

		const ran = await shell(host, as, storageStepCommand())

		expect(ran.status).not.toBe(0)
		expect(ran.stdout.trim(), ran.stderr).toBe("used")
		expect(await exists(host, "/home/pod3/.config/containers/storage.conf")).toBe(false)
	})

	it("refuses each of the four storage overrides, writing nothing and starting no Podman", async () => {
		const as = await withUserManager(host, "pod4")

		for (const variable of STORAGE_OVERRIDE_VARIABLES) {
			const overridden = withEnv(as, { [variable]: "/home/pod4/elsewhere" })

			const ran = await shell(host, overridden, storageStepCommand())

			expect(ran.stdout.trim(), `${variable}: ${ran.stderr}`).toBe("refused")
			expect((await factsOf(host, overridden)).overrides).toEqual([variable])
		}

		const systemConf = "/etc/containers/storage.conf"
		const kept = await exists(host, systemConf)
		succeeded(
			await shell(
				host,
				ROOT,
				'if [ -e "$1" ]; then cp -p "$1" "$1.sandbox-kept"; fi; mkdir -p "$(dirname "$1")"; printf \'[storage]\\nrootless_storage_path = "/home/pod4/elsewhere"\\n\' > "$1"',
				systemConf,
			),
			"writing rootless_storage_path",
		)
		try {
			const ran = await shell(host, as, storageStepCommand())

			expect(ran.stdout.trim(), ran.stderr).toBe("refused")
			expect((await factsOf(host, as)).overrides).toEqual(["rootless_storage_path"])
		} finally {
			succeeded(
				await shell(host, ROOT, kept ? 'mv -f "$1.sandbox-kept" "$1"' : 'rm -f "$1"', systemConf),
				"restoring the system storage.conf",
			)
		}

		expect((await factsOf(host, as)).storage).toBe("fresh")
		expect(await exists(host, "/home/pod4/.config/containers")).toBe(false)
		expect(await exists(host, "/home/pod4/.local/share/containers/storage")).toBe(false)
	})

	it("runs the storage step again, and succeeds, after it was interrupted right after its rename", async () => {
		const as = await withUserManager(host, "pod6")
		succeeded(
			await shell(
				host,
				{ ...ROOT, input: "#!/bin/sh\nkill -9 0\n" },
				"install -d -m 0755 /opt/interrupt && cat > /opt/interrupt/podman && chmod 0755 /opt/interrupt/podman",
			),
			"installing a podman that interrupts the step",
		)

		const interrupted = await shell(
			host,
			withEnv(as, { PATH: `/opt/interrupt:${DEFAULT_PATH}` }),
			storageStepCommand(),
		)

		expect(interrupted.status).not.toBe(0)
		expect(interrupted.stdout).not.toContain("ready")
		expect(
			await exec(host, ROOT, ["cat", "/home/pod6/.config/containers/storage.conf"]),
		).toMatchObject({ stdout: STORAGE_CONF })
		expect(
			succeeded(
				await exec(host, ROOT, ["ls", "-A", "/home/pod6/.config/containers"]),
				"listing",
			).trim(),
		).toBe("storage.conf")

		const again = await shell(host, as, storageStepCommand())

		expect(again.stdout.trim(), again.stderr).toBe("ready")
		expect(again.status).toBe(0)
	})

	describe("running a stand-in client the way a bot runs", () => {
		let as: As = ROOT

		const unit = (id: string): string => `standin@${id}.service`

		const prepare = async (id: string) =>
			succeeded(
				await shell(
					host,
					as,
					'mkdir -p "$HOME/standin/$1" && rm -f "$HOME/standin/$1/control" && mkfifo -m 0600 "$HOME/standin/$1/control"',
					id,
				),
				`preparing ${id}`,
			)

		const manager = async (...args: readonly string[]) =>
			succeeded(
				await exec(host, as, ["systemctl", "--user", ...args]),
				`systemctl --user ${args.join(" ")}`,
			)

		const property = async (id: string, name: string): Promise<string> =>
			(await manager("show", "-p", name, "--value", unit(id))).trim()

		const until = async (what: string, condition: string, ...args: readonly string[]) =>
			succeeded(
				await shell(
					host,
					as,
					`for attempt in $(seq 400); do if ${condition}; then exit 0; fi; sleep 0.1; done; exit 1`,
					...args,
				),
				`waiting until ${what}`,
			)

		const journal = async (id: string): Promise<string> =>
			succeeded(
				await exec(host, as, ["journalctl", "--user", "-u", unit(id), "-o", "cat", "--no-pager"]),
				"reading the unit's journal",
			)

		const journalHas = (id: string, line: string, count = 1) =>
			until(
				`${unit(id)} logged '${line}' ${count} times`,
				'[ "$(journalctl --user -u "$1" -o cat --no-pager | grep -cxF -- "$2")" -ge "$3" ]',
				unit(id),
				line,
				String(count),
			)

		const send = async (id: string, line: string) =>
			succeeded(
				await shell(
					host,
					as,
					'timeout 5 sh -c \'printf "%s\\n" "$2" > "$HOME/standin/$1/control"\' sh "$1" "$2"',
					id,
					line,
				),
				`writing to ${id}'s control`,
			)

		const start = async (id: string) => {
			await prepare(id)
			await manager("start", unit(id))
			await journalHas(id, "standin-up")
		}

		beforeAll(async () => {
			as = await withUserManager(host, "pod5")
			const setUp = await shell(host, as, storageStepCommand())
			expect(setUp.stdout.trim(), setUp.stderr).toBe("ready")
			succeeded(
				await exec(host, { ...as, timeoutMs: 600_000 }, ["podman", "pull", "--quiet", BUSYBOX]),
				"pulling busybox",
			)
			succeeded(
				await shell(
					host,
					{ ...as, input: STANDIN },
					'mkdir -p "$HOME/standin" && cat > "$HOME/standin/standin.sh"',
				),
				"writing the stand-in client",
			)
			succeeded(
				await shell(
					host,
					{ ...as, input: standinUnit(target.network) },
					'mkdir -p "$HOME/.config/systemd/user" && cat > "$HOME/.config/systemd/user/standin@.service"',
				),
				"writing the stand-in unit",
			)
			await manager("daemon-reload")
		}, 900_000)

		it("carries the client's exit codes to systemd: 4 stays down, and 3 restarts", async () => {
			await start("exits")

			await send("exits", "/exit4")
			await until(
				"the unit failed",
				'[ "$(systemctl --user is-active "$1")" = failed ]',
				unit("exits"),
			)

			expect(await property("exits", "ExecMainStatus")).toBe("4")
			expect(await property("exits", "NRestarts")).toBe("0")

			await manager("reset-failed", unit("exits"))
			await manager("start", unit("exits"))
			await journalHas("exits", "standin-up", 2)
			await send("exits", "/exit3")
			await journalHas("exits", "standin-up", 3)

			expect(Number(await property("exits", "NRestarts"))).toBeGreaterThanOrEqual(1)
			expect(await journal("exits")).toMatch(/status=3/)
			await manager("stop", unit("exits"))
		})

		it("stops cleanly, leaving no container, helper process, network namespace or cgroup behind", async () => {
			await start("stops")
			const cgroup = await property("stops", "ControlGroup")

			await manager("stop", unit("stops"))

			expect(cgroup).not.toBe("")
			expect(await exists(host, `/sys/fs/cgroup${cgroup}`)).toBe(false)

			expect(await property("stops", "ActiveState")).toBe("inactive")
			expect(await property("stops", "Result")).toBe("success")
			expect(await property("stops", "ExecMainStatus")).toBe("0")
			expect(await journal("stops")).toContain("got:/quit\nbye")
			const containers = succeeded(
				await exec(host, as, ["podman", "ps", "-a", "--format", "{{.Names}}"]),
				"listing containers",
			)
			expect(containers.trim()).toBe("")
			const helpers = await shell(
				host,
				as,
				'pgrep -u "$(id -u)" -l "conmon|slirp4netns|pasta|passt|rootlessport" || true',
			)
			expect(helpers.stdout.trim()).toBe("")
			const namespaces = await shell(
				host,
				as,
				'find "$XDG_RUNTIME_DIR/netns" -mindepth 1 2>/dev/null || true',
			)
			expect(namespaces.stdout.trim()).toBe("")
		})

		it("restarts after the client is killed, and the new client answers the console", async () => {
			await start("kills")
			const client = succeeded(
				await shell(
					host,
					as,
					'init=$(podman inspect --format "{{.State.Pid}}" standin-kills) && pgrep -P "$init"',
				),
				"finding the client's process",
			).trim()

			succeeded(await exec(host, as, ["kill", "-9", client]), "killing the client")
			await journalHas("kills", "standin-up", 2)

			expect(Number(await property("kills", "NRestarts"))).toBeGreaterThanOrEqual(1)
			expect(await journal("kills")).toMatch(/status=137/)
			await send("kills", "after-the-kill")
			await journalHas("kills", "got:after-the-kill")
			await manager("stop", unit("kills"))
		})

		it("hands a line written to the control FIFO to the client, whose output lands in the unit's journal", async () => {
			await start("console")

			await send("console", "hello from the console")
			await journalHas("console", "got:hello from the console")

			const payload = succeeded(
				await shell(
					host,
					as,
					'cg=$(systemctl --user show -p ControlGroup --value "$1") && ls "/sys/fs/cgroup$cg" | grep -c "^libpod-payload-"',
					unit("console"),
				),
				"reading the unit's cgroup",
			)
			expect(payload.trim()).toBe("1")
			await manager("stop", unit("console"))
		})

		it("keeps one container from another's processes, environment, files and published port", async () => {
			const network = `--network=${target.network}`
			const hostAddress = succeeded(
				await shell(host, ROOT, "ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1"),
				"reading the host's address",
			).trim()
			try {
				succeeded(
					await shell(
						host,
						as,
						[
							"set -eu",
							'mkdir -p "$HOME/iso/a" "$HOME/iso/b"',
							"(umask 077; printf 'SECRET_A=isolated-secret\\n' > \"$HOME/iso/a.env\")",
							`podman run -d --name iso-a --user 0:0 --cap-drop=all --security-opt=no-new-privileges --read-only --env-file "$HOME/iso/a.env" -v "$HOME/iso/a":/data ${network} -p 127.0.0.1:18080:8080 -p 127.0.0.1:18081:8081 ${BUSYBOX} sh -c 'echo file-of-A > /data/a.txt; mkdir -p /tmp/www; echo hello-from-A > /tmp/www/index.html; httpd -f -p 0.0.0.0:8080 -h /tmp/www & httpd -f -p 127.0.0.1:8081 -h /tmp/www & wait'`,
							`podman run -d --name iso-b --user 0:0 --cap-drop=all --security-opt=no-new-privileges --read-only -v "$HOME/iso/b":/data ${network} ${BUSYBOX} sleep 600`,
						].join("\n"),
					),
					"starting containers A and B",
				)
				await until(
					"A serves on its published port",
					"curl -s -m 1 http://127.0.0.1:18080/ | grep -q hello-from-A",
				)

				const inB = async (script: string): Promise<string> =>
					(await exec(host, as, ["podman", "exec", "iso-b", "sh", "-c", script])).stdout +
					(
						await exec(host, as, [
							"podman",
							"exec",
							"iso-b",
							"sh",
							"-c",
							`${script} 2>&1 >/dev/null`,
						])
					).stdout

				expect(await inB("ps -o args")).not.toContain("httpd")
				expect(
					(
						await inB("cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c SECRET_A")
					).trim(),
				).toMatch(/^0/)
				expect(
					(await inB("find / -name a.txt -not -path '/proc/*' 2>/dev/null | wc -l")).trim(),
				).toMatch(/^0/)
				expect(
					await inB(
						"gw=$(ip route | awk '/^default/ {print $3}'); wget -q -T 3 -O - \"http://$gw:18080/\"",
					),
				).not.toContain("hello-from-A")
				expect(await inB("wget -q -T 3 -O - http://169.254.1.2:18080/")).not.toContain(
					"hello-from-A",
				)
				expect(await inB(`wget -q -T 3 -O - http://${hostAddress}:18080/`)).not.toContain(
					"hello-from-A",
				)
				expect(
					await inB(
						"mkdir -p /tmp/w && echo hijacked-by-B > /tmp/w/index.html && httpd -p 127.0.0.1:18080 -h /tmp/w && echo bound-in-B",
					),
				).toContain("bound-in-B")
				expect(
					(await exec(host, as, ["curl", "-s", "-m", "3", "http://127.0.0.1:18080/"])).stdout,
				).toContain("hello-from-A")
				expect(
					(await exec(host, as, ["curl", "-s", "-m", "3", "http://127.0.0.1:18081/"])).stdout,
				).not.toContain("hello-from-A")
				expect(
					(
						await exec(host, as, [
							"podman",
							"run",
							"--rm",
							network,
							"-p",
							"127.0.0.1:18080:80",
							BUSYBOX,
							"true",
						])
					).status,
				).not.toBe(0)
			} finally {
				await exec(host, as, ["podman", "rm", "-f", "--ignore", "-t", "0", "iso-a", "iso-b"])
			}
		})
	})
})

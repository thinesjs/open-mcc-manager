import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { type ProvisionResult, provisionHost } from "../../packages/core/src/host/provision"
import { podmanImageId, runtimeImageFor } from "../../packages/core/src/host/runtime-image"
import { tearDownHost } from "../../packages/core/src/host/teardown"
import {
	InstanceRemovalFailedError,
	InstanceStillInUseError,
} from "../../packages/core/src/instance/instance.controller"
import { deleteDirectoryCommand } from "../../packages/core/src/instance/removal"
import type { ExecResult } from "../../packages/transport/src/types"
import { HOST_ID, installStandInClient, memoryManager, owner } from "./memory-manager"
import {
	HOME,
	inContainer,
	PODMAN_TARGETS,
	shellTransport,
	startPodmanHost,
	withUserManager,
} from "./podman-account"
import { type As, ROOT, remove, shell, succeeded } from "./sandbox"

const FILES = `${HOME}/.local/share/open-mcc`

const MANAGER = "systemctl --user"

const HOLD = `${HOME}/hold`

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

const HELD_CHMOD = ["#!/bin/sh", 'touch "$(dirname "$0")/reached"', "exec sleep 3600", ""].join(
	"\n",
)

const LOCK_A_DIRECTORY =
	"mkdir -p /data/locked/inside && echo kept > /data/locked/inside/file && chmod 000 /data/locked && echo locked"

const LEFTOVERS = [
	'count() { pgrep -u "$(id -u)" -f "$1" | wc -l | tr -d " "; }',
	`printf 'containers=%s\\n' "$(podman ps -a --format '{{.Names}}' | grep -c '^open-mcc-')"`,
	`printf 'monitor=%s\\n' "$(count '[c]onmon')"`,
	`printf 'network=%s\\n' "$(count '[s]lirp4netns|[p]asta|[p]asst|[r]ootlessport')"`,
	`printf 'init=%s\\n' "$(count '[p]odman-init')"`,
	`printf 'client=%s\\n' "$(count '/opt/mcc/[M]inecraftClient')"`,
	`printf 'netns=%s\\n' "$(find "$XDG_RUNTIME_DIR/netns" -mindepth 1 2>/dev/null | wc -l | tr -d " ")"`,
	`printf 'listener=%s\\n' "$(ss -Hltn "sport = :$1" | wc -l | tr -d " ")"`,
	`printf 'cgroup=%s\\n' "$(${MANAGER} show -p ControlGroup --value "open-mcc@$2.service")"`,
	`printf 'held=%s\\n' "$(count '[s]leep 3600')"`,
].join("\n")

const NOTHING_LEFT = {
	containers: "0",
	monitor: "0",
	network: "0",
	init: "0",
	client: "0",
	netns: "0",
	listener: "0",
	cgroup: "",
	held: "0",
}

type Hooks = {
	before: (command: string) => Promise<void>
	after: (command: string, result: ExecResult) => Promise<void>
}

const quiet = (): Hooks => ({ before: async () => undefined, after: async () => undefined })

describe.each(PODMAN_TARGETS)("removing bots from a rootless Podman host on $name", (target) => {
	let host = ""
	let as: As = ROOT
	let provisioned: ProvisionResult | undefined
	let hooks = quiet()

	const ready = (): ProvisionResult => {
		if (provisioned === undefined) throw new Error("the sandbox host was never provisioned")
		return provisioned
	}

	const managerThrough = async (through: As) =>
		await memoryManager(ready(), () => {
			const transport = shellTransport(host, through)
			const run = transport.exec
			transport.exec = async (command: string, timeoutMs: number, stdin?: string) => {
				await hooks.before(command)
				const result = await run(command, timeoutMs, stdin)
				await hooks.after(command, result)
				return result
			}
			return transport
		})

	type Manager = Awaited<ReturnType<typeof managerThrough>>

	const runningBot = async (manager: Manager, name: string) => {
		const created = await manager.controller.create(owner, {
			hostId: HOST_ID,
			name,
			accountType: "offline",
			minecraftAccount: "SandboxBot",
			serverAddress: "127.0.0.1",
		})
		await manager.controller.start(owner, created.id)
		return { id: created.id, port: manager.rows.get(created.id)?.liveControlPort ?? 0 }
	}

	const leftovers = async (bot: { id: string; port: number }): Promise<Record<string, string>> =>
		Object.fromEntries(
			succeeded(
				await shell(host, as, LEFTOVERS, String(bot.port), bot.id),
				"listing what is left of the bot",
			)
				.split("\n")
				.filter((line) => line.includes("="))
				.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
		)

	const activeState = async (id: string): Promise<string> =>
		succeeded(
			await shell(
				host,
				as,
				`${MANAGER} show -p ActiveState --value "$1"`,
				`open-mcc@${id}.service`,
			),
			"reading the bot's state",
		).trim()

	const exists = async (path: string): Promise<boolean> =>
		(await shell(host, as, 'test -e "$1"', path)).status === 0

	const lockADirectoryIn = async (bot: { id: string }): Promise<void> => {
		const said = await inContainer(
			host,
			as,
			`open-mcc-${bot.id}`,
			"making a directory the account cannot read, from inside the bot",
			["/opt/mcc/busybox", "sh", "-c", LOCK_A_DIRECTORY],
		)
		const onTheHost = await shell(
			host,
			as,
			'[ -d "$1/locked" ] && ! ls "$1/locked" >/dev/null 2>&1',
			`${FILES}/instances/${bot.id}/state`,
		)
		expect(
			{ said, unreadableOnTheHost: onTheHost.status === 0 },
			`the bot's own exec must land first: ${said}${onTheHost.stderr}`,
		).toEqual({ said: "locked\n", unreadableOnTheHost: true })
	}

	const refusalOf = async (removal: Promise<void>): Promise<Error | undefined> =>
		await removal.then(
			() => undefined,
			(error: Error) => error,
		)

	beforeAll(async () => {
		host = await startPodmanHost(inject("sandbox"), target)
		as = await withUserManager(host)
	}, 2_400_000)

	beforeAll(async () => {
		provisioned = await provisionHost(shellTransport(host, as))
		await installStandInClient(host, as)
		succeeded(
			await shell(
				host,
				{ ...as, input: HELD_CHMOD },
				'mkdir -p "$1" && cat > "$1/chmod" && chmod 0755 "$1/chmod"',
				HOLD,
			),
			"installing a chmod that never finishes",
		)
	}, 900_000)

	afterAll(async () => {
		await remove(host)
	}, 300_000)

	it("★ removes a running bot, leaving no container, conmon, network helper, netns or listener behind", async () => {
		const manager = await managerThrough(as)
		const bot = await runningBot(manager, "removed-bot")
		const running = await leftovers(bot)

		await manager.controller.remove(owner, bot.id)

		expect({
			containers: running.containers,
			client: Number(running.client) > 0,
			listener: running.listener,
		}).toEqual({ containers: "1", client: true, listener: "1" })
		expect(await leftovers(bot)).toEqual(NOTHING_LEFT)
		expect(manager.rows.has(bot.id)).toBe(false)
		expect(await exists(`${FILES}/instances/${bot.id}`)).toBe(false)
		expect(await activeState(bot.id)).toBe("inactive")
	})

	it("★ keeps the row and fails removal when a start slips in before the delete, and a retry then removes everything", async () => {
		const manager = await managerThrough(as)
		const bot = await runningBot(manager, "raced-bot")
		const started: string[] = []
		hooks = {
			before: async (command) => {
				if (command !== deleteDirectoryCommand(bot.id) || started.length > 0) return
				const ran = await shell(
					host,
					{ ...as, timeoutMs: 120_000 },
					`${MANAGER} start "$1"; ${MANAGER} show -p ActiveState --value "$1"`,
					`open-mcc@${bot.id}.service`,
				)
				started.push(ran.stdout.trim())
			},
			after: async () => undefined,
		}
		let refused: Error | undefined
		try {
			refused = await refusalOf(manager.controller.remove(owner, bot.id))
		} finally {
			hooks = quiet()
		}
		const rowKept = manager.rows.has(bot.id)

		await manager.controller.remove(owner, bot.id)

		expect(started).toEqual(["active"])
		expect(refused).toBeInstanceOf(InstanceStillInUseError)
		expect(rowKept).toBe(true)
		expect(manager.rows.has(bot.id)).toBe(false)
		expect(await leftovers(bot)).toEqual(NOTHING_LEFT)
	})

	it("★ fails a start issued after the delete, leaving no active unit, and the removal still finishes", async () => {
		const manager = await managerThrough(as)
		const bot = await runningBot(manager, "late-bot")
		const late: Record<string, string | boolean | number | null>[] = []
		hooks = {
			before: async () => undefined,
			after: async (command) => {
				if (command !== deleteDirectoryCommand(bot.id) || late.length > 0) return
				const ran = await shell(
					host,
					{ ...as, timeoutMs: 120_000 },
					`${MANAGER} start "$1"`,
					`open-mcc@${bot.id}.service`,
				)
				const now = await leftovers(bot)
				late.push({
					status: ran.status,
					state: await activeState(bot.id),
					containers: now.containers ?? "",
					client: now.client ?? "",
					directory: await exists(`${FILES}/instances/${bot.id}`),
				})
			},
		}
		let refused: Error | undefined
		try {
			refused = await refusalOf(manager.controller.remove(owner, bot.id))
		} finally {
			hooks = quiet()
		}
		const retried = manager.rows.has(bot.id)
		if (retried) await manager.controller.remove(owner, bot.id)

		expect(late).toHaveLength(1)
		expect(late[0]?.state, JSON.stringify(late)).not.toBe("active")
		expect({
			containers: late[0]?.containers,
			client: late[0]?.client,
			directory: late[0]?.directory,
		}).toEqual({ containers: "0", client: "0", directory: false })
		expect(
			refused === undefined || refused instanceof InstanceStillInUseError,
			String(refused),
		).toBe(true)
		expect(manager.rows.has(bot.id), `retried: ${retried}`).toBe(false)
		expect(await leftovers(bot)).toEqual(NOTHING_LEFT)
	})

	it("★ removes a bot whose state/ holds a directory the bot made unreadable", async () => {
		const manager = await managerThrough(as)
		const bot = await runningBot(manager, "locked-bot")
		await lockADirectoryIn(bot)

		const refused = await refusalOf(manager.controller.remove(owner, bot.id))

		expect(refused).toBeUndefined()
		expect(manager.rows.has(bot.id)).toBe(false)
		expect(await exists(`${FILES}/instances/${bot.id}`)).toBe(false)
		expect(await leftovers(bot)).toEqual(NOTHING_LEFT)
	})

	it("★ kills a delete held past its host deadline, reports it as 124 or 137, and keeps the row", async () => {
		const held = await managerThrough({
			...as,
			env: { ...as.env, PATH: `${HOLD}:${DEFAULT_PATH}` },
		})
		const bot = await runningBot(held, "held-bot")
		const deleted: number[] = []
		hooks = {
			before: async () => undefined,
			after: async (command, result) => {
				if (command === deleteDirectoryCommand(bot.id)) deleted.push(result.exitCode)
			},
		}
		let refused: Error | undefined
		try {
			refused = await refusalOf(held.controller.remove(owner, bot.id))
		} finally {
			hooks = quiet()
		}

		expect(refused, String(refused)).toBeInstanceOf(InstanceStillInUseError)
		expect(deleted).toHaveLength(1)
		expect([124, 137]).toContain(deleted[0])
		expect(await exists(`${HOLD}/reached`)).toBe(true)
		expect(held.rows.has(bot.id)).toBe(true)
		expect(await exists(`${FILES}/instances/${bot.id}`)).toBe(true)
		expect(await leftovers(bot)).toEqual(NOTHING_LEFT)
	}, 300_000)

	it("★ fails removal and keeps the row while the bots' directory cannot be searched, then finishes once it can", async () => {
		const manager = await managerThrough(as)
		const bot = await runningBot(manager, "unsearchable-bot")
		const instances = `${FILES}/instances`
		const mode = succeeded(
			await shell(host, as, 'stat -c %a "$1"', instances),
			"reading the bots' directory mode",
		).trim()
		hooks = {
			before: async (command) => {
				if (command !== deleteDirectoryCommand(bot.id)) return
				succeeded(
					await shell(host, as, 'chmod 000 "$1"', instances),
					"making the bots' directory unsearchable",
				)
			},
			after: async () => undefined,
		}
		let refused: Error | undefined
		try {
			refused = await refusalOf(manager.controller.remove(owner, bot.id))
		} finally {
			hooks = quiet()
			succeeded(
				await shell(host, as, 'chmod "$2" "$1"', instances, mode),
				"restoring the bots' directory",
			)
		}
		const kept = {
			row: manager.rows.has(bot.id),
			token: await exists(`${FILES}/instances/${bot.id}/env`),
		}

		expect(refused, String(refused)).toBeInstanceOf(InstanceRemovalFailedError)
		expect(kept).toEqual({ row: true, token: true })

		await manager.controller.remove(owner, bot.id)

		expect(manager.rows.has(bot.id)).toBe(false)
		expect(await exists(`${FILES}/instances/${bot.id}`)).toBe(false)
		expect(await leftovers(bot)).toEqual(NOTHING_LEFT)
	})

	it("★ tears the host down past a directory a bot made unreadable, leaving the spike's leftover list empty", async () => {
		const manager = await managerThrough(as)
		const bot = await runningBot(manager, "last-bot")
		await lockADirectoryIn(bot)
		const running = await leftovers(bot)
		const image = podmanImageId(runtimeImageFor(ready().architecture))
		const imageBefore = (await shell(host, as, 'podman image exists "$1"', image)).status

		const report = await tearDownHost(shellTransport(host, as))

		expect({ containers: running.containers, listener: running.listener }).toEqual({
			containers: "1",
			listener: "1",
		})
		expect(imageBefore).toBe(0)
		expect(report.remaining).toEqual([])
		expect(report.directoryRemoved).toBe(true)
		expect(await leftovers(bot)).toEqual(NOTHING_LEFT)
		expect(
			succeeded(
				await shell(host, as, 'ls -1 "$HOME/.config/systemd/user" | grep -c "^open-mcc" || true'),
				"listing the account's unit files",
			).trim(),
		).toBe("0")
		expect((await shell(host, as, 'podman image exists "$1"', image)).status).toBe(1)
		expect(await exists(FILES)).toBe(false)
	}, 600_000)
})

import { instanceConfigInput, type SleepWindowInput } from "@open-mcc/contracts"
import type {
	AuditEventRow,
	HostRow,
	InstanceCommandRow,
	InstanceConfigRow,
	InstanceRow,
	InstanceScheduleRow,
	SshKeyRow,
} from "@open-mcc/db"
import { DatabaseError } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"

const READER_RESULTS = {
	readPlayerStats: {
		health: 11,
		foodLevel: 12,
		level: 13,
		totalExperience: 14,
		gamemode: 1,
		currentSlot: 5,
		yaw: 6,
		pitch: 7,
		tps: 18,
	},
	readStatusEffects: [{ id: "Wither", amplifier: 4, remainingSeconds: 44, isInfinite: false }],
	readLoadedBots: [{ name: "SentinelBot", isScript: true }],
	readPlayersList: ["SentinelPlayer"],
} as const

const refusedReaders = new Set<string>()

vi.mock("./live-control", async (importOriginal) => {
	const real = await importOriginal<typeof import("./live-control")>()
	const stub = (name: keyof typeof READER_RESULTS) => async () => {
		if (refusedReaders.has(name)) throw new Error(`${name} refused`)
		return READER_RESULTS[name]
	}
	return {
		...real,
		readPlayerStats: stub("readPlayerStats"),
		readStatusEffects: stub("readStatusEffects"),
		readLoadedBots: stub("readLoadedBots"),
		readPlayersList: stub("readPlayersList"),
	}
})

import type { AuditEntry, AuditRepository } from "../audit/audit.repository"
import { HostMisconfiguredError } from "../host/host.controller"
import type { HostRepository, OrgScope } from "../host/host.repository"
import { systemProfile } from "../host/profile"
import { AUTH_UNIT_NAME, INSTANCE_UNIT_NAME, renderUnitTemplates } from "../host/unit-template"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import type { CommandRepository } from "./command.repository"
import { renderInstanceConfig } from "./config"
import {
	type ActorContext,
	createInstanceController,
	ForbiddenError,
	HostUnreachableError,
	InstanceAuthInProgressError,
	InstanceBotConfigUnusableError,
	InstanceConfigUnusableError,
	type InstanceControllerDeps,
	InstanceNotFoundError,
	InstanceNotRunningError,
	InstanceRemovalFailedError,
	InstanceStillInUseError,
} from "./instance.controller"
import type { InstanceRepository } from "./instance.repository"
import type { ScheduleRepository } from "./schedule.repository"
import { instanceDir, instanceUser, unitName } from "./unit"

const owner: ActorContext = {
	organizationId: "org-1",
	memberId: "member-1",
	actorLabel: "owner@example.com",
	role: "owner",
}

const viewer: ActorContext = { ...owner, role: "viewer" }
const operator: ActorContext = { ...owner, role: "operator" }

const instanceRow = (overrides: Partial<InstanceRow> = {}): InstanceRow => ({
	id: "abc123",
	organizationId: "org-1",
	hostId: "host-1",
	name: "afk-1",
	accountType: "microsoft",
	liveControlPort: 33333,
	liveControlTokenEncrypted: null,
	liveControlTokenKeyId: null,
	minecraftAccount: "afk@example.com",
	minecraftUsername: null,
	status: "stopped",
	lastExitCode: null,
	authClaimId: null,
	authClaimedAt: null,
	createdAt: new Date(),
	...overrides,
})

const hostRow: HostRow = {
	id: "host-1",
	organizationId: "org-1",
	name: "vps",
	hostname: "10.0.0.1",
	port: 22,
	username: "root",
	mode: "system",
	instancesRoot: "/srv/open-mcc",
	unitDir: "/etc/systemd/system",
	sandboxed: true,
	osId: "debian",
	osName: "Debian GNU/Linux 12 (bookworm)",
	failedUnits: null,
	teardownError: null,
	teardownRequestedAt: null,
	sshKeyId: "key-1",
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: "SHA256:trusted",
	hostKeyTrustedBy: null,
	hostKeyTrustedByLabel: "unknown",
	hostKeyTrustedAt: null,
	status: "ready",
	provisioningAttemptId: null,
	provisioningClaimedAt: null,
	provisioningStep: null,
	provisioningStepIndex: null,
	provisioningStepTotal: null,
	provisioningError: null,
	osRelease: null,
	cpuCount: null,
	memoryMb: null,
	lastSeenAt: null,
	createdAt: new Date(),
}

const SAVED_DOCUMENT = {
	accountType: "microsoft",
	minecraftAccount: "a@b.com",
	serverAddress: "play.example.net",
	autoRelogRetries: 3,
	autoRelogEnabled: true,
	autoRelogDelaySeconds: { min: 10, max: 10 },
	antiAfkEnabled: false,
	antiAfkIntervalSeconds: { min: 60, max: 60 },
	autoRespawnEnabled: false,
	liveControlEnabled: false,
	liveControlPort: 33333,
	worldDataEnabled: false,
	inventoryDataEnabled: false,
	entityDataEnabled: false,
	advancedKeys: {},
	botConfig: {},
}

const configRow = (overrides: Partial<InstanceConfigRow> = {}): InstanceConfigRow => ({
	id: "cfg-1",
	organizationId: "org-1",
	instanceId: "abc123",
	version: 1,
	document: "",
	authorId: null,
	authorLabel: "owner@example.com",
	createdAt: new Date(),
	...overrides,
})

const sshKeyRow: SshKeyRow = {
	id: "key-1",
	organizationId: "org-1",
	name: "key-1",
	publicKey: "ssh-ed25519 AAAA",
	privateKeyEncrypted: "sealed",
	privateKeyKeyId: "k1",
	createdAt: new Date(),
}

const auditEventRow = (overrides: Partial<AuditEventRow> = {}): AuditEventRow => ({
	id: "audit-1",
	organizationId: "org-1",
	actorId: "member-1",
	actorLabel: "owner@example.com",
	action: "instance.create",
	subjectType: "instance",
	subjectId: "abc123",
	detail: {},
	createdAt: new Date(),
	...overrides,
})

const scheduleRow = (overrides: Partial<InstanceScheduleRow> = {}): InstanceScheduleRow => ({
	id: "sched-1",
	organizationId: "org-1",
	instanceId: "abc123",
	daysOfWeek: "Mon,Tue",
	stopMinuteOfDay: 18 * 60 + 50,
	startMinuteOfDay: 19 * 60 + 30,
	timezone: "Asia/Kuala_Lumpur",
	enabled: true,
	createdAt: new Date(),
	...overrides,
})

const commandRow = (overrides: Partial<InstanceCommandRow> = {}): InstanceCommandRow => ({
	id: "cmd-1",
	organizationId: "org-1",
	instanceId: "abc123",
	name: "morning wave",
	command: "/say good morning",
	daysOfWeek: "Mon",
	minuteOfDay: 540,
	timezone: "UTC",
	enabled: true,
	lastRunAt: null,
	lastRunError: null,
	createdAt: new Date(),
	...overrides,
})

const makeDeps = (overrides: Partial<InstanceControllerDeps> = {}) => {
	const transport = createFakeTransport()
	const audit: Pick<AuditRepository, "record"> = {
		record: vi.fn(async (_scope: OrgScope, entry: AuditEntry) => auditEventRow({ ...entry })),
	}
	const instances: InstanceRepository = {
		findById: vi.fn(async () => instanceRow()),
		list: vi.fn(async () => [instanceRow()]),
		insert: vi.fn(async (_scope, values) => instanceRow(values)),
		update: vi.fn(async () => instanceRow({ status: "running" })),
		delete: vi.fn(async () => true),
		claimForAuth: vi.fn(async () => instanceRow()),
		releaseAuthClaim: vi.fn(async () => true),
		insertConfigVersion: vi.fn(async () => configRow()),
		latestConfig: vi.fn(async () => undefined),
	}
	const schedules: ScheduleRepository = {
		upsert: vi.fn(async () => scheduleRow()),
		findByInstance: vi.fn(async () => undefined),
		list: vi.fn(async () => []),
		delete: vi.fn(async () => true),
	}
	const commands: CommandRepository = {
		upsert: vi.fn(async () => commandRow()),
		listForInstance: vi.fn(async () => []),
		listEnabledAcrossOrganizations: vi.fn(async () => []),
		delete: vi.fn(async () => true),
		deleteReturning: vi.fn(async () => commandRow()),
		claimRun: vi.fn(async () => true),
		recordRun: vi.fn(async () => undefined),
	}
	const hosts: Pick<HostRepository, "findById"> = {
		findById: vi.fn(async () => hostRow),
	}
	const sshKeys: Pick<SshKeyRepository, "findById"> = {
		findById: vi.fn(async () => sshKeyRow),
	}
	const deps: InstanceControllerDeps = {
		instances,
		schedules,
		commands,
		hosts,
		sshKeys,
		secrets: {
			open: () => "PRIVATE KEY",
			seal: (plaintext: string) => ({ ciphertext: `sealed(${plaintext.length})`, keyId: "k1" }),
			activeKeyId: "k1",
		},
		createTransport: () => transport,
		withTransaction: async (fn) => await fn({ instances, schedules, commands, audit }),
		...overrides,
	}
	return { transport, audit, instances, deps }
}

describe("instance controller authorization", () => {
	it("refuses a viewer's attempt to start an instance without touching the host", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps)
		await expect(controller.start(viewer, "abc123")).rejects.toThrow(ForbiddenError)
		expect(transport.commands).toEqual([])
	})

	it("refuses an operator's attempt to create an instance", async () => {
		const { deps } = makeDeps()
		const controller = createInstanceController(deps)
		await expect(
			controller.create(operator, {
				hostId: "host-1",
				name: "n",
				accountType: "microsoft",
				minecraftAccount: "a@b.com",
				serverAddress: "play.example.com",
			}),
		).rejects.toThrow(ForbiddenError)
	})

	it("lets an operator send a console command to a running instance", async () => {
		const { deps, transport, instances } = makeDeps()
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "running" }))
		const controller = createInstanceController(deps)
		await controller.sendCommand(operator, "abc123", "/say hi")
		expect(transport.stdins).toContain("//say hi\n")
	})

	it("refuses a command to an instance that is not running, whose fifo has no reader", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps)

		await expect(controller.sendCommand(operator, "abc123", "/say hi")).rejects.toThrow(
			InstanceNotRunningError,
		)
		expect(transport.commands).toEqual([])
	})

	it("refuses a viewer's console write while allowing the read", async () => {
		const { deps } = makeDeps()
		const controller = createInstanceController(deps)
		await expect(controller.sendCommand(viewer, "abc123", "/say hi")).rejects.toThrow(
			ForbiddenError,
		)
		await expect(controller.readConsole(viewer, "abc123", 10)).resolves.toBeDefined()
	})
})

describe("instance controller lifecycle guards", () => {
	it("refuses to start an instance that has not completed its microsoft sign-in", async () => {
		const { deps, transport } = makeDeps()
		deps.instances.findById = vi.fn(async () => instanceRow({ status: "needs_auth" }))
		const controller = createInstanceController(deps)
		await expect(controller.start(owner, "abc123")).rejects.toThrow(InstanceAuthInProgressError)
		expect(transport.commands).toEqual([])
	})

	it("refuses to remove an instance whose auth claim is still live", async () => {
		const { deps, transport } = makeDeps()
		deps.instances.findById = vi.fn(async () =>
			instanceRow({ authClaimId: "attempt-1", authClaimedAt: new Date() }),
		)
		const controller = createInstanceController(deps)
		await expect(controller.remove(owner, "abc123")).rejects.toThrow(InstanceAuthInProgressError)
		expect(transport.commands).toEqual([])
	})

	it("allows removal once the auth claim has gone stale", async () => {
		const { deps } = makeDeps()
		deps.instances.findById = vi.fn(async () =>
			instanceRow({ authClaimId: "attempt-1", authClaimedAt: new Date(Date.now() - 3_600_000) }),
		)
		const controller = createInstanceController(deps)
		await expect(controller.remove(owner, "abc123")).resolves.toBeUndefined()
	})

	it("reports a missing instance rather than reaching for a host", async () => {
		const { deps, transport } = makeDeps()
		deps.instances.findById = vi.fn(async () => undefined)
		const controller = createInstanceController(deps)
		await expect(controller.start(owner, "nope")).rejects.toThrow(InstanceNotFoundError)
		expect(transport.commands).toEqual([])
	})
})

describe("instance creation prepares the host", () => {
	it("creates the user, directory and control fifo, and writes the environment as stdin", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps)
		await controller.create(owner, {
			hostId: "host-1",
			name: "afk-1",
			accountType: "microsoft",
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
		})

		const joined = transport.commands.join("\n")
		expect(joined).toContain("useradd -r -U")
		expect(joined).toContain("mkfifo -m 0600")
		expect(joined).toContain("/srv/open-mcc/instances/abc123/env")
		expect(transport.stdins.some((each) => each.includes("MCC_MCP_AUTH_TOKEN="))).toBe(true)
	})

	it("seals the live control token rather than storing it in the clear", async () => {
		const { deps } = makeDeps()
		const controller = createInstanceController(deps)
		await controller.create(owner, {
			hostId: "host-1",
			name: "afk-1",
			accountType: "microsoft",
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
		})

		expect(deps.instances.insert).toHaveBeenCalledWith(
			{ organizationId: owner.organizationId },
			expect.objectContaining({
				liveControlTokenEncrypted: "sealed(32)",
				liveControlTokenKeyId: "k1",
			}),
		)
	})

	it("never writes the token into the config file the client rewrites", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps)
		await controller.create(owner, {
			hostId: "host-1",
			name: "afk-1",
			accountType: "microsoft",
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
		})

		const written = transport.stdins.find((each) => each.includes("[ChatBot.McpServer]"))
		expect(written).toBeDefined()
		expect(written).not.toContain("MCC_MCP_AUTH_TOKEN=")
	})

	it("gives the instance a private group and no group-readable state, so co-tenants cannot reach it", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps)

		await controller.create(owner, {
			hostId: "host-1",
			name: "afk-1",
			accountType: "microsoft",
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
		})

		const joined = transport.commands.join("\n")
		const user = "mcc-abc123"

		expect(joined).not.toContain("open-mcc'")
		expect(joined).not.toContain("-g open-mcc")
		expect(joined).toContain(`install -d -m 0700 -o '${user}' -g '${user}'`)
		expect(joined).toContain(`chown '${user}:${user}' '/srv/open-mcc/instances/abc123/control'`)
		expect(joined).toContain("(umask 077; cat > '/srv/open-mcc/instances/abc123/env')")

		for (const mode of joined.match(/-m [0-7]{4}/g) ?? []) {
			expect(Number.parseInt(mode.slice(3), 8) & 0o077).toBe(0)
		}
	})

	it("creates the instance user idempotently so a retry after a partial failure does not fail", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps)
		await controller.create(owner, {
			hostId: "host-1",
			name: "afk-1",
			accountType: "microsoft",
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
		})
		expect(transport.commands.find((each) => each.includes("useradd"))).toContain("|| true")
	})
})

describe("sleep windows", () => {
	it("returns null rather than undefined when no window exists, which react-query rejects", async () => {
		const { deps } = makeDeps()
		const controller = createInstanceController(deps)

		await expect(controller.getSleepWindow(owner, "abc123")).resolves.toBeNull()
	})

	const window: SleepWindowInput = {
		instanceId: "abc123",
		daysOfWeek: ["Mon", "Tue"],
		stopAt: { hour: 18, minute: 50 },
		startAt: { hour: 19, minute: 30 },
		timezone: "Asia/Kuala_Lumpur",
	}

	it("refuses a viewer's attempt to schedule sleep without touching the host", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps)

		await expect(controller.setSleepWindow(viewer, window)).rejects.toThrow(ForbiddenError)
		expect(transport.commands).toEqual([])
	})

	it("lets an operator schedule sleep, since it is an operational concern", async () => {
		const { deps } = makeDeps()
		const controller = createInstanceController(deps)

		await expect(controller.setSleepWindow(operator, window)).resolves.toBeDefined()
	})

	it("writes both timers, reloads systemd, then enables them in that order", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps)

		await controller.setSleepWindow(owner, window)

		const written = transport.commands.filter((each) => each.startsWith("cat > "))
		expect(written).toEqual([
			"cat > '/etc/systemd/system/open-mcc-sleep-stop@abc123.timer'",
			"cat > '/etc/systemd/system/open-mcc-sleep-start@abc123.timer'",
		])
		const reload = transport.commands.indexOf("systemctl daemon-reload")
		const enable = transport.commands.findIndex((each) => each.startsWith("systemctl enable"))
		expect(reload).toBeGreaterThan(transport.commands.indexOf(written[1] ?? ""))
		expect(enable).toBeGreaterThan(reload)
	})

	it("sends the rendered timer as stdin rather than interpolating it into a command", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps)

		await controller.setSleepWindow(owner, window)

		expect(
			transport.stdins.some((each) =>
				each.includes("OnCalendar=Mon,Tue *-*-* 18:50:00 Asia/Kuala_Lumpur"),
			),
		).toBe(true)
	})

	it("records nothing when the host will not take the timers, and says so as a host problem", async () => {
		const refusing = createFakeTransport({
			"cat > '/etc/systemd/system/open-mcc-sleep-stop@abc123.timer'": {
				stdout: "",
				stderr: "Permission denied",
				exitCode: 1,
			},
		})
		const { deps, audit } = makeDeps({ createTransport: () => refusing })
		const controller = createInstanceController(deps)

		await expect(controller.setSleepWindow(owner, window)).rejects.toBeInstanceOf(
			HostMisconfiguredError,
		)
		expect(deps.schedules.upsert).not.toHaveBeenCalled()
		expect(audit.record).not.toHaveBeenCalled()
	})

	it("records nothing when the host cannot be reached to write the timers", async () => {
		const unreachable = createFakeTransport({}, { connect: new Error("connect ETIMEDOUT") })
		const { deps, audit } = makeDeps({ createTransport: () => unreachable })
		const controller = createInstanceController(deps)

		await expect(controller.setSleepWindow(owner, window)).rejects.toBeInstanceOf(
			HostUnreachableError,
		)
		expect(deps.schedules.upsert).not.toHaveBeenCalled()
		expect(audit.record).not.toHaveBeenCalled()
	})

	const START_TIMER_ENABLE = "systemctl enable --now 'open-mcc-sleep-start@abc123.timer'"

	const refusingStart = () =>
		createFakeTransport({
			[START_TIMER_ENABLE]: { stdout: "", stderr: "Failed to enable unit", exitCode: 1 },
		})

	it("takes a new window's timers back off the host when one of them will not enable", async () => {
		const refusing = refusingStart()
		const { deps } = makeDeps({ createTransport: () => refusing })
		const controller = createInstanceController(deps)

		await expect(controller.setSleepWindow(owner, window)).rejects.toBeInstanceOf(
			HostMisconfiguredError,
		)

		const afterFailure = refusing.commands.slice(refusing.commands.indexOf(START_TIMER_ENABLE) + 1)
		expect(afterFailure).toContain(
			"systemctl disable --now 'open-mcc-sleep-stop@abc123.timer' || true",
		)
		expect(afterFailure).toContain("rm -f '/etc/systemd/system/open-mcc-sleep-stop@abc123.timer'")
		expect(deps.schedules.upsert).not.toHaveBeenCalled()
	})

	it("puts the stored window's timers back when a changed window will not enable", async () => {
		const refusing = refusingStart()
		const { deps } = makeDeps({ createTransport: () => refusing })
		vi.mocked(deps.schedules.findByInstance).mockResolvedValue(scheduleRow())
		const controller = createInstanceController(deps)

		await expect(
			controller.setSleepWindow(owner, { ...window, timezone: "UTC" }),
		).rejects.toBeInstanceOf(HostMisconfiguredError)

		expect(refusing.stdins.at(-2)).toContain("Asia/Kuala_Lumpur")
		expect(refusing.stdins.at(-1)).toContain("Asia/Kuala_Lumpur")
		expect(deps.schedules.upsert).not.toHaveBeenCalled()
	})

	it("keeps the window when the host cannot be reached to remove its timers", async () => {
		const unreachable = createFakeTransport({}, { connect: new Error("connect ETIMEDOUT") })
		const { deps, audit } = makeDeps({ createTransport: () => unreachable })
		const controller = createInstanceController(deps)

		await expect(controller.clearSleepWindow(owner, "abc123")).rejects.toBeInstanceOf(
			HostUnreachableError,
		)
		expect(deps.schedules.delete).not.toHaveBeenCalled()
		expect(audit.record).not.toHaveBeenCalled()
	})

	it("disables and removes both timers when the window is cleared", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps)

		await controller.clearSleepWindow(owner, "abc123")

		const joined = transport.commands.join("\n")
		expect(joined).toContain("systemctl disable --now 'open-mcc-sleep-stop@abc123.timer'")
		expect(joined).toContain("systemctl disable --now 'open-mcc-sleep-start@abc123.timer'")
		expect(joined).toContain("rm -f '/etc/systemd/system/open-mcc-sleep-stop@abc123.timer'")
	})
})

describe("what a scheduled command's failure records", () => {
	it("says the host refused the connection without the address the error named", async () => {
		const refusing = createFakeTransport(
			{},
			{
				connect: Object.assign(new Error("connect ECONNREFUSED 203.0.113.9:2222"), {
					code: "ECONNREFUSED",
				}),
			},
		)
		const { deps, instances } = makeDeps({ createTransport: () => refusing })
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "running" }))
		const controller = createInstanceController(deps)

		await expect(controller.runScheduledCommand(commandRow())).rejects.toThrow(
			/^The server refused the connection$/,
		)
	})
})

describe("reconciliation", () => {
	it("reports an unreachable host as unknown, never as drift", async () => {
		const { deps } = makeDeps()
		deps.createTransport = () => {
			const transport = createFakeTransport()
			transport.connect = async () => {
				throw new Error("Connection refused")
			}
			return transport
		}
		const controller = createInstanceController(deps)

		const result = await controller.reconcileHost(owner, "host-1")

		expect(result.reachable).toBe(false)
		expect(result).not.toHaveProperty("unitDrift")
		expect(result).not.toHaveProperty("stateDrift")
	})

	it("reports a host whose unit listing is refused as unknown, not as having nothing extra", async () => {
		const { deps, transport } = makeDeps()
		const original = transport.exec
		transport.exec = async (command: string, timeoutMs: number, stdin?: string) =>
			command.startsWith("ls -1")
				? { stdout: "", stderr: "Permission denied", exitCode: 2 }
				: await original(command, timeoutMs, stdin)
		const controller = createInstanceController(deps)

		const result = await controller.reconcileHost(owner, "host-1")

		expect(result.reachable).toBe(false)
		expect(result).not.toHaveProperty("unitDrift")
	})

	it("reports a host that dies mid-check as unknown rather than fully drifted", async () => {
		const { deps, transport } = makeDeps()
		transport.exec = async () => {
			throw new Error("Connection reset by peer")
		}
		const controller = createInstanceController(deps)

		const result = await controller.reconcileHost(owner, "host-1")

		expect(result.reachable).toBe(false)
		if (result.reachable) throw new Error("unreachable expected")
		expect(result.reason).toBe("interrupted")
	})

	it("★ never carries the host's own words about why, which name its address", async () => {
		const { deps } = makeDeps()
		deps.createTransport = () => {
			const transport = createFakeTransport()
			transport.connect = async () => {
				throw new Error("connect ECONNREFUSED 10.4.5.6:22")
			}
			return transport
		}
		const controller = createInstanceController(deps)

		const result = await controller.reconcileHost(owner, "host-1")

		expect(JSON.stringify(result)).not.toContain("10.4.5.6")
		expect(result).toEqual({ hostId: "host-1", reachable: false, reason: "unreachable" })
	})

	it("★ tells a host that was never finished apart from one that did not answer", async () => {
		const { deps } = makeDeps({
			hosts: { findById: vi.fn(async () => ({ ...hostRow, instancesRoot: null, unitDir: null })) },
		})
		const controller = createInstanceController(deps)

		const result = await controller.reconcileHost(owner, "host-1")

		expect(result.reachable).toBe(false)
		if (result.reachable) throw new Error("unreachable expected")
		expect(result.reason).toBe("unprovisioned")
	})
})

describe("scheduled commands", () => {
	it("sends a scheduled command with no actor, audited as the scheduler", async () => {
		const { deps, transport, instances, audit } = makeDeps()
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "running" }))
		const controller = createInstanceController(deps)

		await controller.runScheduledCommand(commandRow())

		expect(transport.stdins).toContain("//say good morning\n")
		expect(audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({ actorId: null, actorLabel: "scheduler" }),
		)
	})

	it("refuses to write to a stopped instance's fifo, which nothing is reading", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps)

		await expect(controller.runScheduledCommand(commandRow())).rejects.toThrow(
			InstanceNotRunningError,
		)
		expect(transport.commands).toEqual([])
	})

	it("records which instance and which command a deletion removed", async () => {
		const { deps, audit } = makeDeps()
		const controller = createInstanceController(deps)

		await controller.deleteScheduledCommand(owner, "cmd-1")

		expect(audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({
				subjectId: "abc123",
				detail: expect.objectContaining({
					schedule: "morning wave",
					command: "/say good morning",
				}),
			}),
		)
	})

	it("refuses a viewer's attempt to define a scheduled command", async () => {
		const { deps } = makeDeps()
		const controller = createInstanceController(deps)

		await expect(
			controller.setScheduledCommand(viewer, {
				instanceId: "abc123",
				name: "n",
				command: "/say hi",
				daysOfWeek: ["Mon"],
				runAt: { hour: 9, minute: 0 },
				timezone: "UTC",
				enabled: true,
			}),
		).rejects.toThrow(ForbiddenError)
	})
})

describe("removing an instance", () => {
	it("takes its sleep timers with it, which would otherwise fire forever", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps)

		await controller.remove(owner, "abc123")

		const joined = transport.commands.join("\n")
		expect(joined).toContain("systemctl disable --now 'open-mcc-sleep-stop@abc123.timer'")
		expect(joined).toContain("systemctl disable --now 'open-mcc-sleep-start@abc123.timer'")
		expect(joined).toContain("rm -f '/etc/systemd/system/open-mcc-sleep-stop@abc123.timer'")
		expect(joined).toContain("rm -f '/etc/systemd/system/open-mcc-sleep-start@abc123.timer'")
	})

	const rootlessHostRow: HostRow = {
		...hostRow,
		mode: "rootless",
		username: "mcc",
		instancesRoot: "/home/mcc/.local/share/open-mcc",
		unitDir: "/home/mcc/.config/systemd/user",
	}

	const user = "XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user"

	const PROFILES = [
		{
			mode: "system",
			host: hostRow,
			timer: "systemctl disable --now 'open-mcc-sleep-start@abc123.timer' || true",
			stopInstance:
				"systemctl stop 'open-mcc@abc123.service' || true; systemctl disable 'open-mcc@abc123.service' || true; systemctl reset-failed 'open-mcc@abc123.service' || true",
			stopSignIn:
				"systemctl stop 'open-mcc-auth@abc123.service' || true; systemctl reset-failed 'open-mcc-auth@abc123.service' || true",
			quiet:
				"id -u 'mcc-abc123' >/dev/null 2>&1 || exit 0; pkill -KILL -u 'mcc-abc123'; for attempt in 1 2 3 4 5; do pgrep -u 'mcc-abc123' >/dev/null; [ $? -eq 1 ] && exit 0; sleep 1; done; exit 1",
			directory: "rm -rf -- '/srv/open-mcc/instances/abc123'",
			last: "if id -u 'mcc-abc123' >/dev/null 2>&1; then userdel 'mcc-abc123' || exit 1; fi; ! getent group 'mcc-abc123' >/dev/null || groupdel 'mcc-abc123'",
		},
		{
			mode: "rootless",
			host: rootlessHostRow,
			timer: `${user} disable --now 'open-mcc-sleep-start@abc123.timer' || true`,
			stopInstance: `${user} stop 'open-mcc@abc123.service' || true; ${user} disable 'open-mcc@abc123.service' || true; ${user} reset-failed 'open-mcc@abc123.service' || true`,
			stopSignIn: `${user} stop 'open-mcc-auth@abc123.service' || true; ${user} reset-failed 'open-mcc-auth@abc123.service' || true`,
			quiet: `real=$(cd '/home/mcc/.local/share/open-mcc/instances/abc123' 2>/dev/null && pwd -P) || exit 0; for process in /proc/[0-9]*; do case "$(readlink "$process/cwd" 2>/dev/null)" in "$real"|"$real"/*) exit 1;; esac; done; exit 0`,
			directory: "rm -rf -- '/home/mcc/.local/share/open-mcc/instances/abc123'",
			last: `${user} stop 'open-mcc-auth@abc123.service' || true; ${user} reset-failed 'open-mcc-auth@abc123.service' || true`,
		},
	] as const

	const failed = { stdout: "", stderr: "", exitCode: 1 }

	const removeOn = (host: HostRow, transport: ReturnType<typeof createFakeTransport>) => {
		const { deps, instances, audit } = makeDeps({
			hosts: { findById: vi.fn(async () => host) },
			createTransport: () => transport,
		})
		return { instances, audit, outcome: createInstanceController(deps).remove(owner, "abc123") }
	}

	for (const profile of PROFILES) {
		describe(`on a ${profile.mode} host`, () => {
			it("stops the sign-in unit as well as the instance before checking what is still running", async () => {
				const transport = createFakeTransport()
				await removeOn(profile.host, transport).outcome
				const at = (command: string) => transport.commands.indexOf(command)

				expect(at(profile.stopInstance)).toBeGreaterThanOrEqual(0)
				expect(at(profile.stopSignIn)).toBeGreaterThanOrEqual(0)
				expect(at(profile.stopInstance)).toBeLessThan(at(profile.quiet))
				expect(at(profile.stopSignIn)).toBeLessThan(at(profile.quiet))
			})

			it("takes the sleep timers away first, so neither can start the instance again", async () => {
				const transport = createFakeTransport()
				await removeOn(profile.host, transport).outcome
				const at = (command: string) => transport.commands.indexOf(command)

				expect(at(profile.timer)).toBeGreaterThanOrEqual(0)
				expect(at(profile.timer)).toBeLessThan(at(profile.stopInstance))
			})

			it("deletes the instance's directory, which holds its sign-in and live-control secrets, once nothing is running", async () => {
				const transport = createFakeTransport()
				await removeOn(profile.host, transport).outcome
				const at = (command: string) => transport.commands.indexOf(command)

				expect(at(profile.directory)).toBeGreaterThanOrEqual(0)
				expect(at(profile.quiet)).toBeGreaterThanOrEqual(0)
				expect(at(profile.quiet)).toBeLessThan(at(profile.directory))
			})

			it("stops both units again once the directory is gone, so a start in that window does not outlive the removal", async () => {
				const transport = createFakeTransport()
				await removeOn(profile.host, transport).outcome
				const directoryAt = transport.commands.indexOf(profile.directory)

				expect(directoryAt).toBeGreaterThanOrEqual(0)
				expect(transport.commands.lastIndexOf(profile.stopInstance)).toBeGreaterThan(directoryAt)
				expect(transport.commands.lastIndexOf(profile.stopSignIn)).toBeGreaterThan(directoryAt)
			})

			it("never asks to disable the sign-in unit, which nothing ever enables", async () => {
				const transport = createFakeTransport()
				await removeOn(profile.host, transport).outcome

				expect(
					transport.commands.filter((command) => command.includes("disable 'open-mcc-auth@")),
				).toEqual([])
			})

			it("deletes the row only after every host step has run", async () => {
				const transport = createFakeTransport()
				const { instances, audit, outcome } = removeOn(profile.host, transport)
				let commandsBeforeDelete = -1
				instances.delete = vi.fn(async () => {
					commandsBeforeDelete = transport.commands.length
					return true
				})
				await outcome

				expect(commandsBeforeDelete).toBe(transport.commands.length)
				expect(transport.commands.at(-1)).toBe(profile.last)
				expect(audit.record).toHaveBeenCalledTimes(1)
			})

			it("keeps the row, and deletes nothing, when something is still using the instance", async () => {
				const transport = createFakeTransport({ [profile.quiet]: failed })
				const { instances, audit, outcome } = removeOn(profile.host, transport)

				await expect(outcome).rejects.toThrow(InstanceStillInUseError)
				expect(transport.commands).not.toContain(profile.directory)
				expect(instances.delete).not.toHaveBeenCalled()
				expect(audit.record).not.toHaveBeenCalled()
			})

			it("keeps the row when the host cannot delete the directory", async () => {
				const transport = createFakeTransport({ [profile.directory]: failed })
				const { instances, audit, outcome } = removeOn(profile.host, transport)

				await expect(outcome).rejects.toThrow(InstanceRemovalFailedError)
				expect(transport.commands.at(-1)).toBe(profile.directory)
				expect(instances.delete).not.toHaveBeenCalled()
				expect(audit.record).not.toHaveBeenCalled()
			})

			it("keeps the row when the host cannot be reached", async () => {
				const transport = createFakeTransport({}, { connect: new Error("connection refused") })
				const { instances, audit, outcome } = removeOn(profile.host, transport)

				await expect(outcome).rejects.toThrow(HostUnreachableError)
				expect(transport.commands).toEqual([])
				expect(instances.delete).not.toHaveBeenCalled()
				expect(audit.record).not.toHaveBeenCalled()
			})

			it("keeps the row when a step never answers", async () => {
				const transport = createFakeTransport(
					{},
					{ exec: { [profile.stopInstance]: new Error("Command timed out") } },
				)
				const { instances, audit, outcome } = removeOn(profile.host, transport)

				await expect(outcome).rejects.toThrow("Command timed out")
				expect(instances.delete).not.toHaveBeenCalled()
				expect(audit.record).not.toHaveBeenCalled()
			})
		})
	}

	it("deletes a root host's per-instance account after its directory, and never with -r", async () => {
		const transport = createFakeTransport()
		await removeOn(hostRow, transport).outcome
		const [system] = PROFILES

		expect(transport.commands.filter((command) => command.includes("userdel"))).toEqual([
			system.last,
		])
		expect(transport.commands.indexOf(system.last)).toBeGreaterThan(
			transport.commands.indexOf(system.directory),
		)
		expect(transport.commands.lastIndexOf(system.stopInstance)).toBeLessThan(
			transport.commands.indexOf(system.last),
		)
		expect(transport.commands.lastIndexOf(system.stopSignIn)).toBeLessThan(
			transport.commands.indexOf(system.last),
		)
	})

	it("gives each unit longer to stop than the unit itself waits before killing it", async () => {
		const transport = createFakeTransport()
		await removeOn(hostRow, transport).outcome
		const [system] = PROFILES
		const templates = renderUnitTemplates(systemProfile())
		const stopSeconds = (unit: string) =>
			Number(/^TimeoutStopSec=(\d+)$/m.exec(templates[unit] ?? "")?.[1])
		const timeoutFor = (command: string) => transport.timeouts[transport.commands.indexOf(command)]

		expect(stopSeconds(INSTANCE_UNIT_NAME)).toBeGreaterThan(0)
		expect(stopSeconds(AUTH_UNIT_NAME)).toBeGreaterThan(0)
		expect(timeoutFor(system.stopInstance)).toBeGreaterThan(2 * stopSeconds(INSTANCE_UNIT_NAME) * 1000)
		expect(timeoutFor(system.stopSignIn)).toBeGreaterThan(stopSeconds(AUTH_UNIT_NAME) * 1000)
	})

	it("keeps the row when a root host cannot delete the per-instance account", async () => {
		const [system] = PROFILES
		const transport = createFakeTransport({ [system.last]: failed })
		const { instances, audit, outcome } = removeOn(hostRow, transport)

		await expect(outcome).rejects.toThrow(InstanceRemovalFailedError)
		expect(instances.delete).not.toHaveBeenCalled()
		expect(audit.record).not.toHaveBeenCalled()
	})

	it("never kills or deletes by account on a host whose instances share one", async () => {
		const transport = createFakeTransport()
		await removeOn(rootlessHostRow, transport).outcome

		expect(
			transport.commands.filter(
				(command) =>
					command.includes("pkill") ||
					command.includes("userdel") ||
					command.includes("groupdel") ||
					command.includes("-u 'mcc-"),
			),
		).toEqual([])
	})
})

describe("running several instances on one host", () => {
	it("gives each its own directory and its own unit, so they do not collide", () => {
		const root = "/srv/open-mcc"

		expect(instanceDir(root, "alpha")).not.toBe(instanceDir(root, "beta"))
		expect(unitName("alpha")).toBe("open-mcc@alpha")
		expect(unitName("beta")).toBe("open-mcc@beta")
	})

	it("keeps each instance's account separate where the host has per-instance accounts", () => {
		expect(instanceUser("alpha")).not.toBe(instanceUser("beta"))
	})

	it("keeps the port the row owns, whatever a config save asks for", async () => {
		const { deps } = makeDeps()
		const documents: string[] = []
		deps.instances.insertConfigVersion = async (_scope, _id, document) => {
			documents.push(document)
			return configRow()
		}
		const controller = createInstanceController(deps)
		await controller.updateConfig(owner, "abc123", {
			accountType: "microsoft",
			minecraftAccount: "a@b.com",
			serverAddress: "play.example.net",
			autoRelogRetries: 3,
			autoRelogEnabled: true,
			autoRelogDelaySeconds: { min: 10, max: 10 },
			antiAfkEnabled: false,
			antiAfkIntervalSeconds: { min: 60, max: 60 },
			autoRespawnEnabled: false,
			liveControlEnabled: true,
			liveControlPort: 40000,
			worldDataEnabled: false,
			inventoryDataEnabled: false,
			entityDataEnabled: false,
			advancedKeys: {},
			botConfig: {},
		})

		expect(documents).toHaveLength(1)
		expect(JSON.parse(documents[0] ?? "{}").liveControlPort).toBe(33333)
	})

	it("rewrites the config before starting, because the client clobbers it on exit", async () => {
		const { deps, transport } = makeDeps()
		deps.instances.latestConfig = async () =>
			configRow({
				document: {
					accountType: "microsoft",
					minecraftAccount: "a@b.com",
					serverAddress: "play.example.net",
					autoRelogRetries: 3,
					autoRelogDelaySeconds: 10,
					antiAfkEnabled: false,
					antiAfkIntervalSeconds: 60,
					autoRespawnEnabled: false,
					liveControlEnabled: false,
					liveControlPort: 33333,
					worldDataEnabled: true,
					inventoryDataEnabled: false,
					entityDataEnabled: false,
					advancedKeys: {},
					botConfig: {},
				},
			})
		const controller = createInstanceController(deps)
		await controller.start(owner, "abc123")

		const written = transport.stdins.find((each) => each.includes("[Main.General]"))
		expect(written).toBeDefined()
		expect(written).toContain("TerrainAndMovements = true")
	})

	it("writes that config before the unit is told to start, not after", async () => {
		const { deps, transport } = makeDeps()
		deps.instances.latestConfig = async () =>
			configRow({
				document: {
					accountType: "microsoft",
					minecraftAccount: "a@b.com",
					serverAddress: "play.example.net",
					autoRelogRetries: 3,
					autoRelogDelaySeconds: 10,
					antiAfkEnabled: false,
					antiAfkIntervalSeconds: 60,
					autoRespawnEnabled: false,
					liveControlEnabled: false,
					liveControlPort: 33333,
					worldDataEnabled: false,
					inventoryDataEnabled: false,
					entityDataEnabled: false,
					advancedKeys: {},
					botConfig: {},
				},
			})
		const controller = createInstanceController(deps)
		await controller.start(owner, "abc123")

		const wroteAt = transport.commands.findIndex((command) =>
			command.includes("MinecraftClient.ini"),
		)
		const startedAt = transport.commands.findIndex((command) => command.includes("systemctl"))
		expect(wroteAt).toBeGreaterThanOrEqual(0)
		expect(startedAt).toBeGreaterThan(wroteAt)
	})

	it("reports the port the row owns, not the one the saved config remembers", async () => {
		const { deps } = makeDeps()
		deps.instances.latestConfig = async () =>
			configRow({
				document: {
					accountType: "microsoft",
					minecraftAccount: "a@b.com",
					serverAddress: "play.example.net",
					autoRelogRetries: 3,
					autoRelogDelaySeconds: 10,
					antiAfkEnabled: false,
					antiAfkIntervalSeconds: 60,
					autoRespawnEnabled: false,
					liveControlEnabled: true,
					liveControlPort: 40000,
					worldDataEnabled: false,
					inventoryDataEnabled: false,
					entityDataEnabled: false,
					advancedKeys: {},
					botConfig: {},
				},
			})
		const controller = createInstanceController(deps)

		const config = await controller.getConfig(owner, "abc123")

		expect(config?.liveControlPort).toBe(33333)
	})

	it("restarts by stopping, rewriting the config, then starting, in that order", async () => {
		const { deps, transport } = makeDeps()
		deps.instances.latestConfig = async () =>
			configRow({
				document: {
					accountType: "microsoft",
					minecraftAccount: "a@b.com",
					serverAddress: "play.example.net",
					autoRelogRetries: 3,
					autoRelogDelaySeconds: 10,
					antiAfkEnabled: false,
					antiAfkIntervalSeconds: 60,
					autoRespawnEnabled: false,
					liveControlEnabled: true,
					liveControlPort: 33333,
					worldDataEnabled: false,
					inventoryDataEnabled: false,
					entityDataEnabled: false,
					advancedKeys: {},
					botConfig: {},
				},
			})
		const controller = createInstanceController(deps)

		await controller.restart(owner, "abc123")

		const stoppedAt = transport.commands.findIndex((command) => command.includes("stop"))
		const wroteAt = transport.commands.findIndex((command) =>
			command.includes("MinecraftClient.ini"),
		)
		const startedAt = transport.commands.findIndex((command) => command.includes("start"))

		expect(stoppedAt).toBeGreaterThanOrEqual(0)
		expect(wroteAt).toBeGreaterThan(stoppedAt)
		expect(startedAt).toBeGreaterThan(wroteAt)
	})

	it("mints a new live control token on every start, so a leaked one expires", async () => {
		const { deps, transport } = makeDeps()
		deps.instances.latestConfig = async () => configRow({ document: { ...SAVED_DOCUMENT } })
		const controller = createInstanceController(deps)
		await controller.start(owner, "abc123")

		const wroteEnv = transport.stdins.filter((each) => each.includes("MCC_MCP_AUTH_TOKEN="))
		expect(wroteEnv).toHaveLength(1)
		expect(wroteEnv[0]).toMatch(/MCC_MCP_AUTH_TOKEN="[0-9a-f]{32}"/)
	})

	it("seals the rotated token rather than writing it to the database in the clear", async () => {
		const { deps } = makeDeps()
		deps.instances.latestConfig = async () => configRow({ document: { ...SAVED_DOCUMENT } })
		const sealedTokens: string[] = []
		deps.instances.update = vi.fn(async (_scope, _id, patch) => {
			if (patch.liveControlTokenEncrypted !== undefined) {
				sealedTokens.push(patch.liveControlTokenEncrypted)
			}
			return instanceRow({ status: "running" })
		})
		const controller = createInstanceController(deps)
		await controller.start(owner, "abc123")

		expect(sealedTokens).toHaveLength(1)
		expect(sealedTokens[0]).not.toMatch(/^[0-9a-f]{32}$/)
	})

	it("does not hand out a port something on the host is already listening on", async () => {
		const { deps } = makeDeps()
		const busy = createFakeTransport({}, {}, true, [33333, 33334])
		deps.createTransport = () => busy
		const documents: string[] = []
		deps.instances.insertConfigVersion = async (_scope, _id, document) => {
			documents.push(document)
			return configRow()
		}
		const controller = createInstanceController(deps)
		await controller.create(owner, {
			hostId: "host-1",
			name: "afk-1",
			accountType: "microsoft",
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
		})

		expect(documents).toHaveLength(1)
		expect(JSON.parse(documents[0] ?? "{}").liveControlPort).toBe(33335)
	})

	it("closes the host connection when no port can be allocated", async () => {
		const { deps } = makeDeps()
		const everyPort = Array.from({ length: 600 }, (_, index) => 33333 + index)
		const busy = createFakeTransport({}, {}, true, everyPort)
		deps.createTransport = () => busy
		const controller = createInstanceController(deps)

		await expect(
			controller.create(owner, {
				hostId: "host-1",
				name: "afk-1",
				accountType: "microsoft",
				minecraftAccount: "afk@example.com",
				serverAddress: "play.example.com",
			}),
		).rejects.toThrow(/port/i)
		expect(busy.state()).not.toBe("ready")
	})

	it("tries another port when a sibling claims the one it picked first", async () => {
		const { deps } = makeDeps()
		const free = createFakeTransport({}, {}, true, [])
		deps.createTransport = () => free
		let attempts = 0
		const claimed: number[] = []
		deps.instances.insert = async (_scope, values) => {
			attempts += 1
			claimed.push(values.liveControlPort ?? 0)
			if (attempts === 1) {
				const raced = new Error("duplicate key value violates unique constraint")
				Object.assign(raced, { code: "23505", constraint: "instance_live_control_port_unique" })
				Object.setPrototypeOf(raced, DatabaseError.prototype)
				throw raced
			}
			return instanceRow({ liveControlPort: values.liveControlPort ?? 0 })
		}
		const controller = createInstanceController(deps)
		await controller.create(owner, {
			hostId: "host-1",
			name: "afk-1",
			accountType: "microsoft",
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
		})

		expect(claimed).toEqual([33334, 33335])
	})

	it("reaches live control on the port the row owns, not the one a stale config names", async () => {
		const { deps, transport } = makeDeps()
		deps.instances.findById = async () =>
			instanceRow({
				liveControlPort: 33350,
				liveControlTokenEncrypted: "sealed(32)",
				liveControlTokenKeyId: "k1",
			})
		deps.instances.latestConfig = async () =>
			configRow({
				document: {
					accountType: "microsoft",
					minecraftAccount: "a@b.com",
					serverAddress: "play.example.net",
					autoRelogRetries: 3,
					autoRelogDelaySeconds: 10,
					antiAfkEnabled: false,
					antiAfkIntervalSeconds: 60,
					autoRespawnEnabled: false,
					liveControlEnabled: true,
					liveControlPort: 33333,
					worldDataEnabled: false,
					inventoryDataEnabled: false,
					entityDataEnabled: false,
					advancedKeys: {},
					botConfig: {},
				},
			})
		const controller = createInstanceController(deps)
		await controller.readLiveStatus(owner, "abc123")

		expect(transport.forwarded).toContain(33350)
		expect(transport.forwarded).not.toContain(33333)
	})

	it("expects the port the row owns when checking a host for drift", async () => {
		const { deps } = makeDeps()
		deps.instances.list = async () => [instanceRow({ liveControlPort: 33350 })]
		deps.instances.latestConfig = async () =>
			configRow({
				document: {
					accountType: "microsoft",
					minecraftAccount: "a@b.com",
					serverAddress: "play.example.net",
					autoRelogRetries: 3,
					autoRelogDelaySeconds: 10,
					antiAfkEnabled: false,
					antiAfkIntervalSeconds: 60,
					autoRespawnEnabled: false,
					liveControlEnabled: true,
					liveControlPort: 33333,
					worldDataEnabled: false,
					inventoryDataEnabled: false,
					entityDataEnabled: false,
					advancedKeys: {},
					botConfig: {},
				},
			})
		const controller = createInstanceController(deps)
		const result = await controller.reconcileHost(owner, "host-1")

		if (!result.reachable) throw new Error("expected a reachable host")
		const portDrift = result.configDrift.find(
			(entry) => entry.kind !== "section" && entry.key === "ChatBot.McpServer.Transport.Port",
		)
		expect(portDrift?.expected).not.toBe("33333")
	})
})

describe("the four readouts a controller hands back", () => {
	const liveInstance = () => {
		const { deps } = makeDeps()
		deps.instances.findById = async () =>
			instanceRow({
				liveControlPort: 33350,
				liveControlTokenEncrypted: "sealed(32)",
				liveControlTokenKeyId: "k1",
			})
		deps.instances.latestConfig = async () =>
			configRow({
				document: {
					accountType: "microsoft",
					minecraftAccount: "a@b.com",
					serverAddress: "play.example.net",
					autoRelogRetries: 3,
					autoRelogDelaySeconds: 10,
					antiAfkEnabled: false,
					antiAfkIntervalSeconds: 60,
					autoRespawnEnabled: false,
					liveControlEnabled: true,
					liveControlPort: 33350,
					worldDataEnabled: false,
					inventoryDataEnabled: false,
					entityDataEnabled: false,
					advancedKeys: {},
					botConfig: {},
				},
			})
		return createInstanceController(deps)
	}

	it("returns what its own player-stats reader returned, not a shape of its own", async () => {
		expect(await liveInstance().readLivePlayerStats(owner, "abc123")).toEqual(
			READER_RESULTS.readPlayerStats,
		)
	})

	it("returns what its own status-effects reader returned", async () => {
		expect(await liveInstance().readLiveStatusEffects(owner, "abc123")).toEqual(
			READER_RESULTS.readStatusEffects,
		)
	})

	it("returns what its own loaded-bots reader returned", async () => {
		expect(await liveInstance().readLiveBots(owner, "abc123")).toEqual(
			READER_RESULTS.readLoadedBots,
		)
	})

	it("returns what its own players reader returned", async () => {
		expect(await liveInstance().readLivePlayers(owner, "abc123")).toEqual(
			READER_RESULTS.readPlayersList,
		)
	})

	it.each([
		{ named: "the player stats", reader: "readPlayerStats" },
		{ named: "the status effects", reader: "readStatusEffects" },
		{ named: "the loaded bots", reader: "readLoadedBots" },
		{ named: "the players list", reader: "readPlayersList" },
	])("still answers the other three when $named reader fails", async ({ reader }) => {
		refusedReaders.clear()
		refusedReaders.add(reader)
		const controller = liveInstance()

		const outcomes = await Promise.allSettled([
			controller.readLivePlayerStats(owner, "abc123"),
			controller.readLiveStatusEffects(owner, "abc123"),
			controller.readLiveBots(owner, "abc123"),
			controller.readLivePlayers(owner, "abc123"),
		])
		refusedReaders.clear()

		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1)
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(3)
	})
})

describe("saving the client's own bots, which reuses the config write", () => {
	const SAVED = instanceConfigInput.parse({
		accountType: "microsoft",
		minecraftAccount: "a@b.com",
		serverAddress: "play.example.net",
		autoRelogRetries: 3,
		autoRelogEnabled: true,
		autoRelogDelaySeconds: { min: 10, max: 10 },
		antiAfkEnabled: false,
		antiAfkIntervalSeconds: { min: 60, max: 60 },
		autoRespawnEnabled: false,
		liveControlEnabled: true,
		liveControlPort: 33333,
		worldDataEnabled: true,
		inventoryDataEnabled: false,
		entityDataEnabled: false,
		advancedKeys: { "ChatBot.AutoEat.Enabled": "true" },
		botConfig: { "ChatBot.Alerts.Enabled": "false" },
	})

	const withSavedConfig = () => {
		const made = makeDeps()
		vi.mocked(made.instances.latestConfig).mockResolvedValue(
			configRow({ document: JSON.parse(JSON.stringify(SAVED)) }),
		)
		return made
	}

	const writtenDocument = (instances: InstanceRepository) => {
		const call = vi.mocked(instances.insertConfigVersion).mock.calls[0]
		return JSON.parse(String(call?.[2] ?? "{}"))
	}

	it("★ writes the bots it was given and keeps every setting it was not", async () => {
		const { deps, instances } = withSavedConfig()
		const controller = createInstanceController(deps)

		await controller.updateBotConfig(owner, "abc123", {
			botConfig: { "ChatBot.Alerts.Enabled": "true" },
			advancedKeys: SAVED.advancedKeys,
		})

		const document = writtenDocument(instances)
		expect(document.botConfig).toEqual({ "ChatBot.Alerts.Enabled": "true" })
		expect(document.serverAddress).toBe("play.example.net")
		expect(document.advancedKeys).toEqual({ "ChatBot.AutoEat.Enabled": "true" })
		expect(document.worldDataEnabled).toBe(true)
	})

	it("★ writes the config to the host as well, not only to the database", async () => {
		const { deps, transport } = withSavedConfig()
		const controller = createInstanceController(deps)

		await controller.updateBotConfig(owner, "abc123", {
			botConfig: { "ChatBot.Alerts.Enabled": "true" },
			advancedKeys: SAVED.advancedKeys,
		})

		const written = transport.stdins.find((each) => each.includes("[ChatBot.Alerts]"))
		expect(written).toBeDefined()
		expect(written).toContain("Enabled = true")
	})

	it("★ records the write in the audit log, as the config change it is", async () => {
		const { deps, audit } = withSavedConfig()
		const controller = createInstanceController(deps)

		await controller.updateBotConfig(owner, "abc123", {
			botConfig: { "ChatBot.Alerts.Enabled": "true" },
			advancedKeys: SAVED.advancedKeys,
		})

		expect(audit.record).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: "instance.config.update", subjectId: "abc123" }),
		)
	})

	it("★ refuses a viewer before reading anything, not only before writing it", async () => {
		const { deps, instances } = withSavedConfig()
		const controller = createInstanceController(deps)

		await expect(
			controller.updateBotConfig(viewer, "abc123", {
				botConfig: { "ChatBot.Alerts.Enabled": "true" },
				advancedKeys: SAVED.advancedKeys,
			}),
		).rejects.toThrow(ForbiddenError)
		expect(instances.insertConfigVersion).not.toHaveBeenCalled()
		expect(instances.findById).not.toHaveBeenCalled()
		expect(instances.latestConfig).not.toHaveBeenCalled()
	})

	it("★ refuses an instance this organization cannot see, before reading any config", async () => {
		const { deps, instances } = withSavedConfig()
		vi.mocked(instances.findById).mockResolvedValue(undefined)
		const controller = createInstanceController(deps)

		await expect(
			controller.updateBotConfig(owner, "abc123", {
				botConfig: { "ChatBot.Alerts.Enabled": "true" },
				advancedKeys: SAVED.advancedKeys,
			}),
		).rejects.toThrow(InstanceNotFoundError)
		expect(instances.insertConfigVersion).not.toHaveBeenCalled()
	})

	it("★ keeps the saved bots when the operator saves the settings that sit beside them", async () => {
		const { deps, instances } = withSavedConfig()
		const controller = createInstanceController(deps)
		const { botConfig: _bots, advancedKeys: _keys, ...settings } = SAVED

		await controller.updateSettings(owner, "abc123", {
			...settings,
			serverAddress: "moved.example.net",
		})

		const document = writtenDocument(instances)
		expect(document.botConfig).toEqual({ "ChatBot.Alerts.Enabled": "false" })
		expect(document.serverAddress).toBe("moved.example.net")
	})

	it("★ keeps the saved advanced keys when the operator saves the settings beside them", async () => {
		const { deps, instances } = withSavedConfig()
		const controller = createInstanceController(deps)
		const { botConfig: _bots, advancedKeys: _keys, ...settings } = SAVED

		await controller.updateSettings(owner, "abc123", {
			...settings,
			serverAddress: "moved.example.net",
		})

		const document = writtenDocument(instances)
		expect(document.advancedKeys).toEqual({ "ChatBot.AutoEat.Enabled": "true" })
		expect(document.serverAddress).toBe("moved.example.net")
	})

	it("★ writes the advanced keys it was given and keeps every setting it was not", async () => {
		const { deps, instances } = withSavedConfig()
		const controller = createInstanceController(deps)

		await controller.updateBotConfig(owner, "abc123", {
			botConfig: { "ChatBot.Alerts.Enabled": "true" },
			advancedKeys: { "ChatBot.AutoEat.Threshold": "9" },
		})

		const document = writtenDocument(instances)
		expect(document.advancedKeys).toEqual({ "ChatBot.AutoEat.Threshold": "9" })
		expect(document.botConfig).toEqual({ "ChatBot.Alerts.Enabled": "true" })
		expect(document.serverAddress).toBe("play.example.net")
	})

	it("writes an empty bot config for an instance saving its settings for the first time", async () => {
		const { deps, instances } = makeDeps()
		const controller = createInstanceController(deps)
		const { botConfig: _bots, advancedKeys: _keys, ...settings } = SAVED

		await controller.updateSettings(owner, "abc123", settings)

		expect(writtenDocument(instances).botConfig).toEqual({})
	})

	it("★ refuses to START an instance whose saved settings the contract would not accept", async () => {
		const { deps, transport, instances } = makeDeps()
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "stopped" }))
		vi.mocked(instances.latestConfig).mockResolvedValue(
			configRow({
				document: { ...JSON.parse(JSON.stringify(SAVED)), serverAddress: "x/../../tmp" },
			}),
		)
		const controller = createInstanceController(deps)

		await expect(controller.start(owner, "abc123")).rejects.toThrow(InstanceConfigUnusableError)
		expect(transport.stdins.find((each) => each.includes("[Main.General]"))).toBeUndefined()
	})

	const withUnusableSavedConfig = () => {
		const made = makeDeps()
		vi.mocked(made.instances.latestConfig).mockResolvedValue(
			configRow({
				document: { ...JSON.parse(JSON.stringify(SAVED)), serverAddress: "x/../../tmp" },
			}),
		)
		return made
	}

	const withReservedBotFile = () => {
		const made = makeDeps()
		vi.mocked(made.instances.latestConfig).mockResolvedValue(
			configRow({
				document: {
					...JSON.parse(JSON.stringify(SAVED)),
					botConfig: { "ChatBot.PlayerListLogger.File": "env" },
				},
			}),
		)
		return made
	}

	it("★ refuses to START on a saved bot file the client already uses as a Bots fault, yet hands it back to fix", async () => {
		const { deps, transport, instances } = withReservedBotFile()
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "stopped" }))
		const controller = createInstanceController(deps)

		await expect(controller.start(owner, "abc123")).rejects.toBeInstanceOf(
			InstanceBotConfigUnusableError,
		)
		expect(transport.stdins.find((each) => each.includes("[Main.General]"))).toBeUndefined()
		expect((await controller.getConfig(owner, "abc123"))?.botConfig).toEqual({
			"ChatBot.PlayerListLogger.File": "env",
		})
	})

	it("★ refuses a Settings save while a saved bot file is refused as a Bots fault, not a Settings one", async () => {
		const { deps, instances } = withReservedBotFile()
		const controller = createInstanceController(deps)
		const { botConfig: _bots, advancedKeys: _keys, ...settings } = SAVED

		await expect(controller.updateSettings(owner, "abc123", settings)).rejects.toBeInstanceOf(
			InstanceBotConfigUnusableError,
		)
		expect(instances.insertConfigVersion).not.toHaveBeenCalled()
	})

	it("★ still reports a safety edit on the host while a saved bot file name is refused", async () => {
		const { deps, transport } = withReservedBotFile()
		const onHost = renderInstanceConfig({
			...SAVED,
			botConfig: { "ChatBot.PlayerListLogger.File": "env" },
			liveControlPort: instanceRow().liveControlPort,
		}).replace("RequireAuthToken = true", "RequireAuthToken = false")
		const exec = transport.exec
		transport.exec = async (command, timeoutMs, stdin) =>
			command.startsWith("cat ") && command.includes("MinecraftClient.ini")
				? { stdout: onHost, stderr: "", exitCode: 0 }
				: await exec(command, timeoutMs, stdin)
		const controller = createInstanceController(deps)

		const result = await controller.reconcileHost(owner, "host-1")

		if (!result.reachable) throw new Error("expected a reachable host")
		expect(result.configDrift.filter((entry) => entry.kind === "unreadable")).toEqual([])
		expect(result.configDrift).toContainEqual(
			expect.objectContaining({
				kind: "fixed",
				key: "ChatBot.McpServer.Transport.RequireAuthToken",
				actual: "false",
			}),
		)
	})

	it("★ refuses a create the contract would not accept, before it touches the host or the database", async () => {
		const { deps, transport, instances } = makeDeps()
		const controller = createInstanceController(deps)

		await expect(
			controller.create(owner, {
				hostId: "host-1",
				name: "afk",
				accountType: "offline",
				minecraftAccount: "OpenMccBot",
				serverAddress: "play.example.com/../../etc",
			}),
		).rejects.toThrow()
		expect(instances.insert).not.toHaveBeenCalled()
		expect(transport.commands).toEqual([])
	})

	it("★ refuses to start on a saved row it cannot even read, not just one it can read and reject", async () => {
		const { deps, transport, instances } = makeDeps()
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "stopped" }))
		vi.mocked(instances.latestConfig).mockResolvedValue(configRow({ document: { nonsense: true } }))
		const controller = createInstanceController(deps)

		await expect(controller.start(owner, "abc123")).rejects.toThrow(InstanceConfigUnusableError)
		expect(transport.stdins.find((each) => each.includes("[Main.General]"))).toBeUndefined()
	})

	it("★ checks the saved settings BEFORE rotating the live-control token", async () => {
		const { deps, instances } = withUnusableSavedConfig()
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "stopped" }))
		const controller = createInstanceController(deps)

		await expect(controller.start(owner, "abc123")).rejects.toThrow(InstanceConfigUnusableError)
		expect(instances.update).not.toHaveBeenCalled()
	})

	it("★ checks the saved settings BEFORE stopping a running unit on restart", async () => {
		const { deps, transport, instances } = withUnusableSavedConfig()
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "running" }))
		const controller = createInstanceController(deps)

		await expect(controller.restart(owner, "abc123")).rejects.toThrow(InstanceConfigUnusableError)
		expect(transport.commands.filter((each) => each.includes("stop"))).toEqual([])
	})

	it("★ reports a saved document it cannot read as drift on THAT instance, not as a failed host", async () => {
		const { deps, instances } = makeDeps()
		vi.mocked(instances.latestConfig).mockResolvedValue(configRow({ document: { nonsense: true } }))
		const controller = createInstanceController(deps)

		const result = await controller.reconcileHost(owner, "host-1")

		expect(result.reachable).toBe(true)
		if (!result.reachable) throw new Error("reachable expected")
		expect(result.configDrift.filter((entry) => entry.kind === "unreadable")).toHaveLength(1)
	})

	it("★ still HANDS BACK a document it would refuse to render, so the operator can repair it", async () => {
		const { deps } = withUnusableSavedConfig()
		const controller = createInstanceController(deps)

		const readable = await controller.getConfig(owner, "abc123")

		expect(readable?.serverAddress).toBe("x/../../tmp")
	})

	it("★ and lets the next settings save replace that bad value", async () => {
		const { deps, instances } = withUnusableSavedConfig()
		const controller = createInstanceController(deps)
		const { botConfig: _bots, advancedKeys: _keys, ...settings } = SAVED

		await controller.updateSettings(owner, "abc123", {
			...settings,
			serverAddress: "play.example.net",
		})

		expect(writtenDocument(instances).serverAddress).toBe("play.example.net")
	})

	it("★ lets a database failure surface as itself, not as a host outage", async () => {
		const { deps, transport, instances } = makeDeps()
		vi.mocked(instances.latestConfig).mockRejectedValue(new Error("connection terminated"))
		const controller = createInstanceController(deps)

		await expect(controller.reconcileHost(owner, "host-1")).rejects.toThrow("connection terminated")
		expect(transport.state()).toBe("disconnected")
	})

	it("★ still reports a transport failure as an unreachable host", async () => {
		const { deps, transport } = withUnusableSavedConfig()
		transport.exec = async () => {
			throw new Error("Connection reset by peer")
		}
		const controller = createInstanceController(deps)

		const result = await controller.reconcileHost(owner, "host-1")

		expect(result.reachable).toBe(false)
	})

	it("★ closes the host connection even when a saved document is unusable", async () => {
		const { deps, transport } = withUnusableSavedConfig()
		const controller = createInstanceController(deps)

		await controller.reconcileHost(owner, "host-1")

		expect(transport.state()).toBe("disconnected")
	})

	it("★ refuses a settings save rather than silently emptying bots it could not read", async () => {
		const { deps, instances } = makeDeps()
		vi.mocked(instances.latestConfig).mockResolvedValue(configRow({ document: { nonsense: true } }))
		const controller = createInstanceController(deps)
		const { botConfig: _bots, advancedKeys: _keys, ...settings } = SAVED

		await expect(controller.updateSettings(owner, "abc123", settings)).rejects.toThrow(
			InstanceConfigUnusableError,
		)
		expect(instances.insertConfigVersion).not.toHaveBeenCalled()
	})

	it("★ refuses a config an in-process caller composed that the contract would not accept", async () => {
		const { deps, instances } = withSavedConfig()
		const controller = createInstanceController(deps)

		await expect(
			controller.updateConfig(owner, "abc123", { ...SAVED, serverAddress: "a/../../etc" }),
		).rejects.toThrow()
		expect(instances.insertConfigVersion).not.toHaveBeenCalled()
	})

	it("refuses an instance with nothing saved rather than inventing a config around the bots", async () => {
		const { deps, instances } = makeDeps()
		const controller = createInstanceController(deps)

		await expect(
			controller.updateBotConfig(owner, "abc123", {
				botConfig: { "ChatBot.Alerts.Enabled": "true" },
				advancedKeys: SAVED.advancedKeys,
			}),
		).rejects.toThrow("No saved settings")
		expect(instances.insertConfigVersion).not.toHaveBeenCalled()
	})
})

describe("stopping an instance", () => {
	it("gives the stop longer than the unit can wait before killing the client", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps)
		const stopSeconds = Number(
			/^TimeoutStopSec=(\d+)$/m.exec(
				renderUnitTemplates(systemProfile())[INSTANCE_UNIT_NAME] ?? "",
			)?.[1],
		)

		await controller.stop(owner, "abc123")

		const stopAt = transport.commands.findIndex((each) => each.includes("stop 'open-mcc@abc123'"))
		expect(stopSeconds).toBeGreaterThan(0)
		expect(stopAt).toBeGreaterThanOrEqual(0)
		expect(transport.timeouts[stopAt]).toBeGreaterThan(2 * stopSeconds * 1000)
	})
})

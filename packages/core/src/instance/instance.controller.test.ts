import type { SleepWindowInput } from "@open-mcc/contracts"
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
import type { AuditEntry, AuditRepository } from "../audit/audit.repository"
import type { HostRepository, OrgScope } from "../host/host.repository"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import type { CommandRepository } from "./command.repository"
import {
	type ActorContext,
	createInstanceController,
	ForbiddenError,
	InstanceAuthInProgressError,
	type InstanceControllerDeps,
	InstanceNotFoundError,
	InstanceNotRunningError,
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
		const created = await controller.create(owner, {
			hostId: "host-1",
			name: "afk-1",
			accountType: "microsoft",
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
		})

		expect(created.liveControlTokenKeyId).not.toBeNull()
		expect(created.liveControlTokenEncrypted).not.toBeNull()
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
		expect(result.reason).toContain("Connection reset")
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
		deps.instances.latestConfig = async () => configRow()
		const controller = createInstanceController(deps)
		await controller.start(owner, "abc123")

		const wroteEnv = transport.stdins.filter((each) => each.includes("MCC_MCP_AUTH_TOKEN="))
		expect(wroteEnv).toHaveLength(1)
		expect(wroteEnv[0]).toMatch(/MCC_MCP_AUTH_TOKEN="[0-9a-f]{32}"/)
	})

	it("seals the rotated token rather than writing it to the database in the clear", async () => {
		const { deps } = makeDeps()
		deps.instances.latestConfig = async () => configRow()
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

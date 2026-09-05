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
		insert: vi.fn(async () => instanceRow()),
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
			seal: () => ({ ciphertext: "", keyId: "k1" }),
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
		expect(transport.stdins.some((each) => each.includes("MCC_SERVER="))).toBe(true)
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
})

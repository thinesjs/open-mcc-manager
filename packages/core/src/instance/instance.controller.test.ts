import { createServer, type Server } from "node:http"
import { connect } from "node:net"
import {
	instanceConfigInput,
	instanceSettingsInput,
	type SleepWindowInput,
} from "@open-mcc/contracts"
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
import {
	ChannelLimitReachedError,
	ChannelOpenTimedOutError,
	CommandAbortedError,
	CommandTimedOutError,
	createFakeTransport,
	createReadConnections,
	LiveChannelUnavailableError,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
	type ReusableTransport,
} from "@open-mcc/transport"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

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
	InstanceBusyError,
	InstanceConcurrentlyModifiedError,
	InstanceConfigUnusableError,
	type InstanceControllerDeps,
	InstanceHostNotProvisionedError,
	InstanceNotFoundError,
	InstanceNotRunningError,
	InstanceRemovalFailedError,
	InstanceSignInRunningError,
	InstanceStillInUseError,
	scheduledRunFailure,
} from "./instance.controller"
import { CONFIG_CLAIM_LEASE_MS, type InstanceRepository } from "./instance.repository"
import { reconcileFactsCommand } from "./reconcile"
import {
	deleteDirectoryCommand,
	removeContainersCommand,
	removeTimersCommand,
	stopUnitsCommand,
	verifyGoneCommand,
} from "./removal"
import type { ScheduleRepository } from "./schedule.repository"
import {
	configWriteCommand,
	ENV_KEPT,
	ENV_WRITTEN,
	envWriteCommand,
	envWriteUnlessRunningCommand,
	instanceDir,
	instanceLayoutSteps,
	renderEnvironmentFile,
	startUnitCommand,
	unitName,
} from "./unit"

const owner: ActorContext = {
	organizationId: "org-1",
	memberId: "member-1",
	actorLabel: "owner@example.com",
	role: "owner",
}

const viewer: ActorContext = { ...owner, role: "viewer" }
const operator: ActorContext = { ...owner, role: "operator" }

const SYSTEMCTL = "XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user"

const UNITS = '"$HOME"/.config/systemd/user'

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
	configClaimId: null,
	configClaimedAt: null,
	playerListOffset: "0",
	playerListFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	playerListCursorVersion: "0",
	createdAt: new Date(),
	...overrides,
})

const UNIT_RUNTIME = {
	networkStack: "slirp4netns",
	imageId: "b54641a0139b45834e25e82fa2cf2be60bafa6a1b6a22868bb1df7182a27a7b9",
} as const

const hostRow: HostRow = {
	id: "host-1",
	organizationId: "org-1",
	name: "vps",
	hostname: "10.0.0.1",
	port: 22,
	username: "mcc",
	networkStack: "slirp4netns",
	architecture: "x64",
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
	osRelease: "systemd 252",
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

const HOST_FACTS = reconcileFactsCommand(
	"56e3d8542b4091c81816101e95875e32ec981577e669112c479a57d4003e4c29",
)

const factsSaying = (version: string) =>
	`open-mcc/units\nopen-mcc/podman\n${version}\nopen-mcc/containers\nopen-mcc/image\n0\nopen-mcc/end\n`

const ROTATES_TOKEN = envWriteUnlessRunningCommand(
	"abc123",
	renderEnvironmentFile({ liveControlToken: "0".repeat(32) }),
	33333,
)

const makeDeps = (overrides: Partial<InstanceControllerDeps> = {}) => {
	const transport = createFakeTransport({
		[startUnitCommand("abc123")]: {
			stdout: "ActiveState=active\nResult=success\nSignIn=inactive\n",
			stderr: "",
			exitCode: 0,
		},
		[ROTATES_TOKEN]: { stdout: `${ENV_WRITTEN}\n`, stderr: "", exitCode: 0 },
		[HOST_FACTS]: { stdout: factsSaying("podman version 4.3.1"), stderr: "", exitCode: 0 },
	})
	const readTransports: { next: () => ReusableTransport } = { next: () => transport }
	const readConnections = createReadConnections({
		createTransport: () => readTransports.next(),
		idleMs: READ_CONNECTION_IDLE_MS,
		hardAgeMs: READ_CONNECTION_HARD_AGE_MS,
		channelLimit: READ_CONNECTION_CHANNEL_LIMIT,
		now: () => Date.now(),
	})
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
		claimForConfig: vi.fn(async () => instanceRow()),
		claimForLifecycle: vi.fn(async () => instanceRow()),
		finalizeConfigClaim: vi.fn(async () => instanceRow()),
		releaseConfigClaim: vi.fn(async () => true),
		writeTokenUnderClaim: vi.fn(async () => true),
		deleteUnderClaim: vi.fn(async () => true),
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
		readConnections,
		withTransaction: async (fn) =>
			await fn({
				instances,
				schedules,
				commands,
				audit,
				hosts: { ...hosts, lockHost: vi.fn(async () => undefined) },
			}),
		now: () => Date.now(),
		...overrides,
	}
	return { transport, audit, instances, deps, readTransports, readConnections }
}

describe("a bot's files and its start", () => {
	const ENV_WRITE = ROTATES_TOKEN

	const CONFIG_WRITE = configWriteCommand(
		"abc123",
		renderInstanceConfig(instanceConfigInput.parse({ ...SAVED_DOCUMENT, liveControlPort: 33333 })),
	)

	const answering = (
		transport: ReturnType<typeof makeDeps>["transport"],
		command: string,
		answer: { stdout: string; stderr: string; exitCode: number },
	) => {
		const original = transport.exec
		transport.exec = async (issued: string, timeoutMs: number, stdin?: string) =>
			issued === command ? answer : await original(issued, timeoutMs, stdin)
	}

	const withSavedConfig = () => {
		const made = makeDeps()
		made.deps.instances.latestConfig = async () => configRow({ document: { ...SAVED_DOCUMENT } })
		return made
	}

	it("makes the whole layout at create, each directory before anything written into it", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps)

		await controller.create(owner, {
			hostId: "host-1",
			name: "afk-1",
			accountType: "microsoft",
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
		})

		const port = vi.mocked(deps.instances.insert).mock.calls[0]?.[1].liveControlPort ?? 0
		const written = transport.stdins.find((each) => !each.startsWith("MCC_MCP_AUTH_TOKEN=")) ?? ""
		expect(port).toBeGreaterThan(0)
		expect(written).not.toBe("")
		expect(transport.commands.filter((command) => command.includes("/instances/abc123"))).toEqual(
			instanceLayoutSteps({
				instanceId: "abc123",
				liveControlPort: port,
				liveControlToken: "0".repeat(32),
				configDocument: written,
			}).map((step) => step.command),
		)
	})

	it("writes into what create made on start and restart, and never makes a directory", async () => {
		const { deps, transport } = withSavedConfig()
		const controller = createInstanceController(deps)

		await controller.start(owner, "abc123")
		await controller.restart(owner, "abc123")

		expect(transport.commands.some((command) => /install -d|mkdir/.test(command))).toBe(false)
		expect(transport.commands.filter((command) => command === CONFIG_WRITE)).toHaveLength(2)
		expect(
			transport.commands.filter((command) => command === startUnitCommand("abc123")),
		).toHaveLength(2)
	})

	it("rotates the live control token into the env file create made, unquoted and exact", async () => {
		const { deps, transport } = withSavedConfig()
		const controller = createInstanceController(deps)

		await controller.start(owner, "abc123")
		await controller.restart(owner, "abc123")

		const tokens = transport.stdins.filter((stdin) => stdin.startsWith("MCC_MCP_AUTH_TOKEN="))
		expect(tokens).toHaveLength(2)
		for (const token of tokens) expect(token).toMatch(/^MCC_MCP_AUTH_TOKEN=[0-9a-f]{32}\n$/)
		expect(tokens[0]).not.toBe(tokens[1])
		expect(transport.commands.filter((command) => command === ENV_WRITE)).toHaveLength(2)
		expect(transport.commands.some((command) => /install -d|mkdir/.test(command))).toBe(false)
	})

	it("rewrites unit.env from the row's port in the exec that writes the token, adding no exec", async () => {
		const { deps, transport } = withSavedConfig()
		const controller = createInstanceController(deps)

		await controller.start(owner, "abc123")
		const started = [...transport.commands]
		transport.commands.length = 0
		await controller.restart(owner, "abc123")

		expect(started).toEqual([ENV_WRITE, CONFIG_WRITE, startUnitCommand("abc123")])
		expect(transport.commands).toEqual([
			`${SYSTEMCTL} stop 'open-mcc@abc123'`,
			ENV_WRITE,
			CONFIG_WRITE,
			startUnitCommand("abc123"),
		])
	})

	it("stores the token it minted once the host says it wrote the file", async () => {
		const { deps, instances } = withSavedConfig()

		await createInstanceController(deps).start(owner, "abc123")

		expect(instances.writeTokenUnderClaim).toHaveBeenCalledTimes(1)
		expect(vi.mocked(instances.writeTokenUnderClaim).mock.calls[0]?.[2]).toBe(
			vi.mocked(instances.claimForLifecycle).mock.calls[0]?.[2],
		)
	})

	it("leaves a running bot's token alone, and still rewrites its config and starts it", async () => {
		const { deps, transport, instances } = withSavedConfig()
		answering(transport, ENV_WRITE, { stdout: `${ENV_KEPT}\n`, stderr: "", exitCode: 0 })

		await createInstanceController(deps).start(owner, "abc123")

		expect(instances.writeTokenUnderClaim).not.toHaveBeenCalled()
		expect(transport.commands).toEqual([CONFIG_WRITE, startUnitCommand("abc123")])
		expect(instances.finalizeConfigClaim).toHaveBeenCalledWith(
			expect.anything(),
			"abc123",
			expect.any(String),
			{ status: "running" },
		)
	})

	const STOP_COMMAND = `${SYSTEMCTL} stop 'open-mcc@abc123'`

	const UNCERTAIN = [
		{ named: "a command that timed out", error: () => new CommandTimedOutError("too slow") },
		{ named: "ssh2's Unable to exec", error: () => new Error("Unable to exec") },
		{
			named: "a channel that opened too late",
			error: () => new ChannelOpenTimedOutError("too slow"),
		},
	]

	const LIFECYCLE_EXECS = [
		{ verb: "start" as const, step: "its env exec", command: () => ENV_WRITE },
		{ verb: "start" as const, step: "its config write", command: () => CONFIG_WRITE },
		{ verb: "start" as const, step: "its start", command: () => startUnitCommand("abc123") },
		{ verb: "restart" as const, step: "its stop", command: () => STOP_COMMAND },
		{ verb: "stop" as const, step: "its stop", command: () => STOP_COMMAND },
	]

	it.each(
		LIFECYCLE_EXECS.flatMap(({ verb, step, command }) =>
			UNCERTAIN.map(({ named, error }) => ({ verb, step, command, named, error })),
		),
	)(
		"keeps the claim when $verb meets $named at $step, because the command may still land",
		async ({ verb, command, error }) => {
			const { deps, transport, instances } = withSavedConfig()
			const failing = command()
			const inner = transport.exec
			transport.exec = async (issued, timeoutMs, stdin) => {
				if (issued === failing) throw error()
				return await inner(issued, timeoutMs, stdin)
			}

			await expect(createInstanceController(deps)[verb](owner, "abc123")).rejects.toThrow()

			expect(instances.releaseConfigClaim).not.toHaveBeenCalled()
			expect(instances.finalizeConfigClaim).not.toHaveBeenCalled()
		},
	)

	it.each(LIFECYCLE_EXECS)(
		"gives the claim back when $verb is refused a session channel at $step, because nothing was sent",
		async ({ verb, command }) => {
			const { deps, transport, instances } = withSavedConfig()
			const failing = command()
			const inner = transport.exec
			transport.exec = async (issued, timeoutMs, stdin) => {
				if (issued === failing) throw new ChannelLimitReachedError("no channel")
				return await inner(issued, timeoutMs, stdin)
			}

			await expect(createInstanceController(deps)[verb](owner, "abc123")).rejects.toBeInstanceOf(
				ChannelLimitReachedError,
			)

			expect(instances.releaseConfigClaim).toHaveBeenCalled()
			expect(instances.finalizeConfigClaim).not.toHaveBeenCalled()
		},
	)

	it.each(["start", "restart", "stop"] as const)(
		"gives the claim back when %s cannot reach the host at all",
		async (verb) => {
			const made = withSavedConfig()
			const deps: InstanceControllerDeps = {
				...made.deps,
				createTransport: () => ({
					...made.transport,
					connect: async () => {
						throw new Error("Connection refused")
					},
				}),
			}

			await expect(createInstanceController(deps)[verb](owner, "abc123")).rejects.toBeInstanceOf(
				HostUnreachableError,
			)

			expect(made.instances.releaseConfigClaim).toHaveBeenCalled()
		},
	)

	it.each(["start", "restart"] as const)(
		"never starts a bot on the settings it already had when a %s's config write is refused",
		async (verb) => {
			const { deps, transport, instances } = withSavedConfig()
			const inner = transport.exec
			transport.exec = async (command, timeoutMs, stdin) => {
				const result = await inner(command, timeoutMs, stdin)
				return command === CONFIG_WRITE
					? { stdout: "", stderr: "No space left on device", exitCode: 1 }
					: result
			}

			await expect(createInstanceController(deps)[verb](owner, "abc123")).rejects.toThrow(
				/Failed to write instance config/,
			)

			expect(transport.commands.some((command) => command.includes("systemctl --user start"))).toBe(
				false,
			)
			expect(instances.finalizeConfigClaim).not.toHaveBeenCalled()
			expect(instances.releaseConfigClaim).toHaveBeenCalled()
		},
	)

	it("refuses a start it cannot tell the answer of, before starting anything", async () => {
		const { deps, transport, instances } = withSavedConfig()
		answering(transport, ENV_WRITE, { stdout: "maybe\n", stderr: "", exitCode: 0 })

		await expect(createInstanceController(deps).start(owner, "abc123")).rejects.toThrow(
			/Could not read whether instance abc123 is running/,
		)

		expect(instances.writeTokenUnderClaim).not.toHaveBeenCalled()
		expect(transport.commands.some((command) => command.includes("systemctl --user start"))).toBe(
			false,
		)
		expect(instances.releaseConfigClaim).toHaveBeenCalled()
		expect(instances.finalizeConfigClaim).not.toHaveBeenCalled()
	})

	it("fails a start into a directory that is gone, before it starts anything", async () => {
		const { deps, transport } = withSavedConfig()
		answering(transport, ENV_WRITE, {
			stdout: "",
			stderr: "sh: 1: cannot create env: Directory nonexistent",
			exitCode: 2,
		})
		const controller = createInstanceController(deps)

		const started = controller.start(owner, "abc123")

		await expect(started).rejects.toThrow(/environment/)
		await expect(started).rejects.not.toBeInstanceOf(InstanceSignInRunningError)
		expect(transport.commands.some((command) => command.includes("systemctl --user start"))).toBe(
			false,
		)
		expect(deps.instances.finalizeConfigClaim).not.toHaveBeenCalled()
		expect(deps.instances.releaseConfigClaim).toHaveBeenCalled()
	})

	it.each([
		[
			"on systemd 252, which reports the skip as a success",
			"ActiveState=inactive\nResult=success\nSignIn=active\n",
		],
		[
			"while sign-in is still starting",
			"ActiveState=inactive\nResult=success\nSignIn=activating\n",
		],
		[
			"where systemd names the skip",
			"ActiveState=inactive\nResult=exec-condition\nSignIn=inactive\n",
		],
	])(
		"says a start was skipped because sign-in is running %s, on start and on restart",
		async (_case, stdout) => {
			const { deps, transport } = withSavedConfig()
			answering(transport, startUnitCommand("abc123"), { stdout, stderr: "", exitCode: 0 })
			const controller = createInstanceController(deps)

			await expect(controller.start(owner, "abc123")).rejects.toBeInstanceOf(
				InstanceSignInRunningError,
			)
			await expect(controller.restart(owner, "abc123")).rejects.toBeInstanceOf(
				InstanceSignInRunningError,
			)
			expect(deps.instances.finalizeConfigClaim).not.toHaveBeenCalled()
			expect(deps.instances.releaseConfigClaim).toHaveBeenCalled()
		},
	)

	it.each([
		["a unit that failed", "ActiveState=failed\nResult=exit-code\nSignIn=inactive\n"],
		[
			"a unit left stopped with no sign-in running",
			"ActiveState=inactive\nResult=success\nSignIn=inactive\n",
		],
		["output it cannot read", "ActiveState=active\r\nResult=success\r\nSignIn=inactive\r\n"],
		["no output at all", ""],
	])("reports %s as a start that failed, never as a success", async (_case, stdout) => {
		const { deps, transport } = withSavedConfig()
		answering(transport, startUnitCommand("abc123"), { stdout, stderr: "", exitCode: 0 })
		const controller = createInstanceController(deps)

		const started = controller.start(owner, "abc123")

		await expect(started).rejects.toThrow(/start/i)
		await expect(started).rejects.not.toBeInstanceOf(InstanceSignInRunningError)
		expect(deps.instances.finalizeConfigClaim).not.toHaveBeenCalled()
		expect(deps.instances.releaseConfigClaim).toHaveBeenCalled()
	})

	it("reports a start systemctl itself refused as the start failure it always was", async () => {
		const { deps, transport } = withSavedConfig()
		answering(transport, startUnitCommand("abc123"), {
			stdout: "",
			stderr: "Job for open-mcc@abc123.service failed",
			exitCode: 1,
		})
		const controller = createInstanceController(deps)

		await expect(controller.start(owner, "abc123")).rejects.toThrow(
			/Failed to start instance abc123/,
		)
		expect(deps.instances.finalizeConfigClaim).not.toHaveBeenCalled()
		expect(deps.instances.releaseConfigClaim).toHaveBeenCalled()
	})
})

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

	it("audits a password command without the password, while the bot still receives it", async () => {
		const { deps, transport, instances, audit } = makeDeps()
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "running" }))
		const controller = createInstanceController(deps)

		await controller.sendCommand(operator, "abc123", "/login hunter2")

		expect(transport.stdins).toContain("//login hunter2\n")
		expect(audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({ detail: { command: "/login [redacted]" } }),
		)
		expect(JSON.stringify(vi.mocked(audit.record).mock.calls)).not.toContain("hunter2")
	})

	it("audits a password behind the double slash the console itself emits", async () => {
		const { deps, transport, instances, audit } = makeDeps()
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "running" }))
		const controller = createInstanceController(deps)

		await controller.sendCommand(operator, "abc123", "//login hunter2")

		expect(transport.stdins).toContain("///login hunter2\n")
		expect(audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({ detail: { command: "//login [redacted]" } }),
		)
		expect(JSON.stringify(vi.mocked(audit.record).mock.calls)).not.toContain("hunter2")
	})

	it("audits an ordinary command as it was typed", async () => {
		const { deps, instances, audit } = makeDeps()
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "running" }))
		const controller = createInstanceController(deps)

		await controller.sendCommand(operator, "abc123", "/say hello everyone")

		expect(audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({ detail: { command: "/say hello everyone" } }),
		)
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

	it("reports a missing instance rather than reaching for a host", async () => {
		const { deps, transport } = makeDeps()
		deps.instances.findById = vi.fn(async () => undefined)
		const controller = createInstanceController(deps)
		await expect(controller.start(owner, "nope")).rejects.toThrow(InstanceNotFoundError)
		expect(transport.commands).toEqual([])
	})
})

describe("instance creation prepares the host", () => {
	it("carries createdAt as the ISO string the wire actually sends, not a Date object", async () => {
		const { deps } = makeDeps()
		vi.mocked(deps.instances.insert).mockResolvedValueOnce(
			instanceRow({ createdAt: new Date("2026-09-01T00:00:00.000Z") }),
		)
		const controller = createInstanceController(deps)

		const created = await controller.create(owner, {
			hostId: "host-1",
			name: "afk-1",
			accountType: "microsoft",
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
		})

		expect(created.createdAt).toBe("2026-09-01T00:00:00.000Z")
	})

	it("creates the directory and control fifo, and writes the environment as stdin", async () => {
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
		expect(joined).toContain("mkfifo -m 0600")
		expect(joined).toContain(
			envWriteCommand("abc123", renderEnvironmentFile({ liveControlToken: "0".repeat(32) })),
		)
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
			expect.any(String),
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

	it("creates no account, changes no owner and keeps no group-readable state, since the connecting account runs every bot", async () => {
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

		expect(joined).not.toContain("useradd")
		expect(joined).not.toContain("chown")
		expect(joined).toContain('install -d -m 0700 "$HOME"/.local/share/open-mcc/instances/abc123')
		expect(joined).toContain(
			envWriteCommand("abc123", renderEnvironmentFile({ liveControlToken: "0".repeat(32) })),
		)

		for (const mode of joined.match(/-m [0-7]{4}/g) ?? []) {
			expect(Number.parseInt(mode.slice(3), 8) & 0o077).toBe(0)
		}
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
			`cat > ${UNITS}/'open-mcc-sleep-stop@abc123.timer'`,
			`cat > ${UNITS}/'open-mcc-sleep-start@abc123.timer'`,
		])
		const reload = transport.commands.indexOf(`${SYSTEMCTL} daemon-reload`)
		const enable = transport.commands.findIndex((each) => each.startsWith(`${SYSTEMCTL} enable`))
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
			[`cat > ${UNITS}/'open-mcc-sleep-stop@abc123.timer'`]: {
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

	const START_TIMER_ENABLE = `${SYSTEMCTL} enable --now 'open-mcc-sleep-start@abc123.timer'`

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
			`${SYSTEMCTL} disable --now 'open-mcc-sleep-stop@abc123.timer' || true`,
		)
		expect(afterFailure).toContain(`rm -f ${UNITS}/'open-mcc-sleep-stop@abc123.timer'`)
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
		expect(joined).toContain(`${SYSTEMCTL} disable --now 'open-mcc-sleep-stop@abc123.timer'`)
		expect(joined).toContain(`${SYSTEMCTL} disable --now 'open-mcc-sleep-start@abc123.timer'`)
		expect(joined).toContain(`rm -f ${UNITS}/'open-mcc-sleep-stop@abc123.timer'`)
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

describe("★ what a scheduled command's failure is recorded as", () => {
	it("says the command could not be sent when the host refused it, never what the host said", async () => {
		const { deps, instances, transport } = makeDeps()
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "running" }))
		transport.exec = async () => ({
			stdout: "",
			stderr: "cat: 203.0.113.9:2222: token hunter2",
			exitCode: 1,
		})
		const failure = await createInstanceController(deps)
			.runScheduledCommand(commandRow())
			.catch((error: Error) => error)

		expect(failure).toBeInstanceOf(Error)
		expect(failure instanceof Error ? scheduledRunFailure(failure) : undefined).toBe(
			"The command could not be sent",
		)
	})

	it("says the bot was not running, in its own words", async () => {
		const { deps } = makeDeps()
		const failure = await createInstanceController(deps)
			.runScheduledCommand(commandRow())
			.catch((error: Error) => error)

		expect(failure instanceof Error ? scheduledRunFailure(failure) : undefined).toBe(
			"The bot was not running",
		)
	})

	it("keeps the fixed reason a connection failure already carries", () => {
		expect(scheduledRunFailure(new HostUnreachableError("The server refused the connection"))).toBe(
			"The server refused the connection",
		)
	})
})

describe("reconciliation", () => {
	it("reports an unreachable host as unknown, never as drift", async () => {
		const { deps, readTransports } = makeDeps()
		readTransports.next = () => {
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
		const original = transport.execUntil
		transport.execUntil = async (command: string, signal: AbortSignal) =>
			command.includes("ls -1")
				? { stdout: "", stderr: "Permission denied", exitCode: 2 }
				: await original(command, signal)
		const controller = createInstanceController(deps)

		const result = await controller.reconcileHost(owner, "host-1")

		expect(result.reachable).toBe(false)
		expect(result).not.toHaveProperty("unitDrift")
	})

	it("reports a host that dies mid-check as unknown rather than fully drifted", async () => {
		const { deps, transport } = makeDeps()
		transport.execUntil = async () => {
			throw new Error("Connection reset by peer")
		}
		const controller = createInstanceController(deps)

		const result = await controller.reconcileHost(owner, "host-1")

		expect(result.reachable).toBe(false)
		if (result.reachable) throw new Error("unreachable expected")
		expect(result.reason).toBe("interrupted")
	})

	it("★ never carries the host's own words about why, which name its address", async () => {
		const { deps, readTransports } = makeDeps()
		readTransports.next = () => {
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

	it("reads the stack the host's live Podman needs against the one its setup recorded", async () => {
		const { deps, transport } = makeDeps()
		const original = transport.execUntil
		transport.execUntil = async (command: string, signal: AbortSignal) =>
			command === HOST_FACTS
				? { stdout: factsSaying("podman version 5.4.2"), stderr: "", exitCode: 0 }
				: await original(command, signal)
		const controller = createInstanceController(deps)

		const result = await controller.reconcileHost(owner, "host-1")

		if (!result.reachable) throw new Error("expected a reachable host")
		expect(result.runtimeDrift).toEqual([{ kind: "network-stack" }])
	})

	it("★ tells a host that was never finished apart from one that did not answer", async () => {
		const { deps } = makeDeps({
			hosts: {
				findById: vi.fn(async () => ({ ...hostRow, status: "pending" as const, osRelease: null })),
			},
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

	it("audits a scheduled password command without the password, while the bot still receives it", async () => {
		const { deps, transport, instances, audit } = makeDeps()
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "running" }))
		const controller = createInstanceController(deps)

		await controller.runScheduledCommand(commandRow({ command: "/login hunter2" }))

		expect(transport.stdins).toContain("//login hunter2\n")
		expect(audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({
				detail: { command: "/login [redacted]", schedule: "morning wave" },
			}),
		)
		expect(JSON.stringify(vi.mocked(audit.record).mock.calls)).not.toContain("hunter2")
	})

	it("audits a password a schedule stored behind the internal prefix, which only fails later", async () => {
		const { deps, audit } = makeDeps()
		const controller = createInstanceController(deps)

		await controller.setScheduledCommand(owner, {
			instanceId: "abc123",
			name: "morning wave",
			command: "!login hunter2",
			daysOfWeek: ["Mon"],
			runAt: { hour: 9, minute: 0 },
			timezone: "UTC",
			enabled: true,
		})

		expect(audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({
				detail: { schedule: "morning wave", command: "!login [redacted]" },
			}),
		)
		expect(JSON.stringify(vi.mocked(audit.record).mock.calls)).not.toContain("hunter2")
	})

	it("audits an ordinary scheduled command as it was stored", async () => {
		const { deps, instances, audit } = makeDeps()
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "running" }))
		const controller = createInstanceController(deps)

		await controller.runScheduledCommand(commandRow())

		expect(audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({
				detail: { command: "/say good morning", schedule: "morning wave" },
			}),
		)
	})

	it("audits the creation and the deletion of a password schedule without the password", async () => {
		const { deps, audit } = makeDeps()
		vi.mocked(deps.commands.deleteReturning).mockResolvedValue(
			commandRow({ command: "/login hunter2" }),
		)
		const controller = createInstanceController(deps)

		await controller.setScheduledCommand(owner, {
			instanceId: "abc123",
			name: "morning wave",
			command: "/login hunter2",
			daysOfWeek: ["Mon"],
			runAt: { hour: 9, minute: 0 },
			timezone: "UTC",
			enabled: true,
		})
		await controller.deleteScheduledCommand(owner, "cmd-1")

		expect(audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({
				detail: { schedule: "morning wave", command: "/login [redacted]" },
			}),
		)
		expect(audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({
				detail: expect.objectContaining({ removed: "true", command: "/login [redacted]" }),
			}),
		)
		expect(JSON.stringify(vi.mocked(audit.record).mock.calls)).not.toContain("hunter2")
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

	it("carries lastRunAt as the ISO string the wire actually sends, not a Date object", async () => {
		const { deps } = makeDeps()
		vi.mocked(deps.commands.listForInstance).mockResolvedValue([
			commandRow({ lastRunAt: new Date("2026-09-01T09:00:00.000Z") }),
		])
		const controller = createInstanceController(deps)

		const [command] = await controller.listScheduledCommands(owner, "abc123")

		expect(command?.lastRunAt).toBe("2026-09-01T09:00:00.000Z")
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
	const STEPS = {
		timers: removeTimersCommand("abc123"),
		stop: stopUnitsCommand("abc123"),
		containers: removeContainersCommand("abc123"),
		verify: verifyGoneCommand("abc123"),
		directory: deleteDirectoryCommand("abc123"),
	} as const

	const removeOn = (host: HostRow, transport: ReturnType<typeof createFakeTransport>) => {
		const { deps, instances, audit } = makeDeps({
			hosts: { findById: vi.fn(async () => host) },
			createTransport: () => transport,
		})
		const controller = createInstanceController(deps)
		return { instances, audit, run: () => controller.remove(owner, "abc123") }
	}

	const answering = (exitCodeFor: (command: string, time: number) => number | undefined) => {
		const transport = createFakeTransport()
		const scripted = transport.exec
		transport.exec = async (command: string, timeoutMs: number, stdin?: string) => {
			const result = await scripted(command, timeoutMs, stdin)
			const time = transport.commands.filter((each) => each === command).length
			return { ...result, exitCode: exitCodeFor(command, time) ?? result.exitCode }
		}
		return transport
	}

	const scope = { organizationId: owner.organizationId }

	const takenClaim = (instances: InstanceRepository): string | undefined =>
		vi.mocked(instances.claimForLifecycle).mock.calls[0]?.[2]

	it("takes the claim first, then runs its seven steps, deleting the row only after the second verify", async () => {
		const transport = createFakeTransport()
		const { instances, audit, run } = removeOn(hostRow, transport)
		const order: string[] = []
		const claim = instances.claimForLifecycle
		instances.claimForLifecycle = async (...args) => {
			order.push("take the claim")
			return await claim(...args)
		}
		instances.deleteUnderClaim = async () => {
			order.push(...transport.commands, "delete the row")
			return true
		}

		await run()

		expect(order).toEqual([
			"take the claim",
			STEPS.timers,
			STEPS.stop,
			STEPS.containers,
			STEPS.verify,
			STEPS.directory,
			STEPS.verify,
			"delete the row",
		])
		expect(audit.record).toHaveBeenCalledTimes(1)
	})

	it("deletes the row under the claim it took, and leaves no claim to release", async () => {
		const transport = createFakeTransport()
		const { instances, run } = removeOn(hostRow, transport)

		await run()

		const claimId = takenClaim(instances)
		expect(claimId).toEqual(expect.any(String))
		expect(instances.deleteUnderClaim).toHaveBeenCalledTimes(1)
		expect(instances.deleteUnderClaim).toHaveBeenCalledWith(scope, "abc123", claimId)
		expect(instances.delete).not.toHaveBeenCalled()
		expect(instances.releaseConfigClaim).not.toHaveBeenCalled()
	})

	it.each([
		{
			named: "the first verify finds something left",
			step: STEPS.verify,
			time: 1,
			exitCode: 1,
			ran: 4,
		},
		{
			named: "the second verify finds a start that slipped in",
			step: STEPS.verify,
			time: 2,
			exitCode: 1,
			ran: 6,
		},
		{
			named: "removing the containers runs out of time",
			step: STEPS.containers,
			time: 1,
			exitCode: 124,
			ran: 3,
		},
		{
			named: "removing the containers has to be killed",
			step: STEPS.containers,
			time: 1,
			exitCode: 137,
			ran: 3,
		},
		{
			named: "deleting the directory runs out of time",
			step: STEPS.directory,
			time: 1,
			exitCode: 124,
			ran: 5,
		},
		{
			named: "deleting the directory has to be killed",
			step: STEPS.directory,
			time: 1,
			exitCode: 137,
			ran: 5,
		},
	])(
		"keeps the row, releases the claim and says the bot is still in use when $named",
		async ({ step, time, exitCode, ran }) => {
			const transport = answering((command, seen) =>
				command === step && seen === time ? exitCode : undefined,
			)
			const { instances, audit, run } = removeOn(hostRow, transport)

			await expect(run()).rejects.toBeInstanceOf(InstanceStillInUseError)
			expect(transport.commands).toHaveLength(ran)
			expect(instances.deleteUnderClaim).not.toHaveBeenCalled()
			expect(instances.releaseConfigClaim).toHaveBeenCalledWith(
				scope,
				"abc123",
				takenClaim(instances),
			)
			expect(audit.record).not.toHaveBeenCalled()
		},
	)

	it.each([
		{ named: "a sleep timer cannot be taken away", step: STEPS.timers, ran: 1 },
		{ named: "the directory cannot be deleted", step: STEPS.directory, ran: 5 },
	])(
		"keeps the row, releases the claim and says removal did not finish when $named",
		async ({ step, ran }) => {
			const transport = answering((command) => (command === step ? 1 : undefined))
			const { instances, audit, run } = removeOn(hostRow, transport)

			await expect(run()).rejects.toBeInstanceOf(InstanceRemovalFailedError)
			expect(transport.commands).toHaveLength(ran)
			expect(instances.deleteUnderClaim).not.toHaveBeenCalled()
			expect(instances.releaseConfigClaim).toHaveBeenCalledWith(
				scope,
				"abc123",
				takenClaim(instances),
			)
			expect(audit.record).not.toHaveBeenCalled()
		},
	)

	it.each([1, 5, 124])(
		"finishes the removal when stopping the units answers %i, whose status removal ignores",
		async (exitCode) => {
			const transport = answering((command) => (command === STEPS.stop ? exitCode : undefined))
			const { instances, audit, run } = removeOn(hostRow, transport)

			await run()

			expect(transport.commands).toHaveLength(6)
			expect(instances.deleteUnderClaim).toHaveBeenCalledTimes(1)
			expect(instances.releaseConfigClaim).not.toHaveBeenCalled()
			expect(audit.record).toHaveBeenCalledTimes(1)
		},
	)

	it.each([
		{
			named: "a step never answers",
			failure: new CommandTimedOutError("Command timed out"),
			step: STEPS.stop,
		},
		{
			named: "the session dies while a step runs",
			failure: new Error("Unable to exec"),
			step: STEPS.directory,
		},
	])(
		"keeps the claim when $named, because the command may still be running",
		async ({ failure, step }) => {
			const transport = createFakeTransport({}, { exec: { [step]: failure } })
			const { instances, audit, run } = removeOn(hostRow, transport)

			await expect(run()).rejects.toThrow(failure.message)
			expect(instances.deleteUnderClaim).not.toHaveBeenCalled()
			expect(instances.releaseConfigClaim).not.toHaveBeenCalled()
			expect(audit.record).not.toHaveBeenCalled()
		},
	)

	it("releases the claim when the host refuses the session channel, because no command was sent", async () => {
		const transport = createFakeTransport(
			{},
			{ exec: { [STEPS.containers]: new ChannelLimitReachedError("No channel") } },
		)
		const { instances, audit, run } = removeOn(hostRow, transport)

		await expect(run()).rejects.toBeInstanceOf(ChannelLimitReachedError)
		expect(instances.deleteUnderClaim).not.toHaveBeenCalled()
		expect(instances.releaseConfigClaim).toHaveBeenCalledWith(
			scope,
			"abc123",
			takenClaim(instances),
		)
		expect(audit.record).not.toHaveBeenCalled()
	})

	it("refuses a removal as busy while another change holds the claim, without reaching the host", async () => {
		const transport = createFakeTransport()
		const connected = vi.spyOn(transport, "connect")
		const { instances, audit, run } = removeOn(hostRow, transport)
		instances.claimForLifecycle = vi.fn(async () => undefined)

		await expect(run()).rejects.toBeInstanceOf(InstanceBusyError)
		expect(connected).not.toHaveBeenCalled()
		expect(transport.commands).toEqual([])
		expect(instances.deleteUnderClaim).not.toHaveBeenCalled()
		expect(instances.releaseConfigClaim).toHaveBeenCalledWith(
			scope,
			"abc123",
			takenClaim(instances),
		)
		expect(audit.record).not.toHaveBeenCalled()
	})

	it("refuses a removal while a sign-in is still live, without reaching the host", async () => {
		const transport = createFakeTransport()
		const connected = vi.spyOn(transport, "connect")
		const { instances, audit, run } = removeOn(hostRow, transport)
		instances.claimForLifecycle = vi.fn(async () => undefined)
		instances.findById = vi.fn(async () =>
			instanceRow({ authClaimId: "attempt-1", authClaimedAt: new Date() }),
		)

		await expect(run()).rejects.toBeInstanceOf(InstanceAuthInProgressError)
		expect(connected).not.toHaveBeenCalled()
		expect(transport.commands).toEqual([])
		expect(instances.deleteUnderClaim).not.toHaveBeenCalled()
		expect(instances.releaseConfigClaim).toHaveBeenCalledWith(
			scope,
			"abc123",
			takenClaim(instances),
		)
		expect(audit.record).not.toHaveBeenCalled()
	})

	it("reports a removal whose row has gone as not found, without reaching the host", async () => {
		const transport = createFakeTransport()
		const connected = vi.spyOn(transport, "connect")
		const { instances, audit, run } = removeOn(hostRow, transport)
		instances.claimForLifecycle = vi.fn(async () => undefined)
		let seen = 0
		instances.findById = vi.fn(async () => {
			seen += 1
			return seen === 1 ? instanceRow() : undefined
		})

		await expect(run()).rejects.toBeInstanceOf(InstanceNotFoundError)
		expect(connected).not.toHaveBeenCalled()
		expect(transport.commands).toEqual([])
		expect(instances.deleteUnderClaim).not.toHaveBeenCalled()
		expect(instances.releaseConfigClaim).toHaveBeenCalledWith(
			scope,
			"abc123",
			takenClaim(instances),
		)
		expect(audit.record).not.toHaveBeenCalled()
	})

	it("reports a removal whose claim was lost before the delete as busy, and records nothing", async () => {
		const transport = createFakeTransport()
		const { instances, audit, run } = removeOn(hostRow, transport)
		instances.deleteUnderClaim = vi.fn(async () => false)

		await expect(run()).rejects.toBeInstanceOf(InstanceBusyError)
		expect(instances.deleteUnderClaim).toHaveBeenCalledTimes(1)
		expect(transport.commands).toHaveLength(6)
		expect(audit.record).not.toHaveBeenCalled()
	})

	it("gives the removal 155 seconds of remote work under the claim, well inside the lease", async () => {
		const transport = createFakeTransport()
		const { instances, run } = removeOn(hostRow, transport)
		let held = false
		const waits: number[] = []
		const claim = instances.claimForLifecycle
		instances.claimForLifecycle = async (...args) => {
			const row = await claim(...args)
			held = true
			return row
		}
		const remove = instances.deleteUnderClaim
		instances.deleteUnderClaim = async (...args) => {
			held = false
			return await remove(...args)
		}
		const connectInner = transport.connect
		transport.connect = async (options) => {
			if (held) waits.push(options.timeoutMs)
			await connectInner(options)
		}
		const execInner = transport.exec
		transport.exec = async (command, timeoutMs, stdin) => {
			if (held) waits.push(timeoutMs)
			return await execInner(command, timeoutMs, stdin)
		}

		await run()

		const budget = waits.reduce((total, each) => total + each, 0)
		expect(waits).toEqual([10_000, 15_000, 45_000, 15_000, 15_000, 40_000, 15_000])
		expect(budget).toBe(155_000)
		expect(budget).toBeLessThan(CONFIG_CLAIM_LEASE_MS)
	})

	it("fails a start issued once the row is gone", async () => {
		const { deps, instances } = makeDeps()
		let removed = false
		instances.findById = vi.fn(async () => (removed ? undefined : instanceRow()))
		instances.deleteUnderClaim = vi.fn(async () => {
			removed = true
			return true
		})
		const controller = createInstanceController(deps)

		await controller.remove(owner, "abc123")

		await expect(controller.start(owner, "abc123")).rejects.toBeInstanceOf(InstanceNotFoundError)
	})

	it("keeps the row and releases the claim when the host cannot be reached", async () => {
		const transport = createFakeTransport({}, { connect: new Error("connection refused") })
		const { instances, audit, run } = removeOn(hostRow, transport)

		await expect(run()).rejects.toThrow(HostUnreachableError)
		expect(transport.commands).toEqual([])
		expect(instances.deleteUnderClaim).not.toHaveBeenCalled()
		expect(instances.releaseConfigClaim).toHaveBeenCalledWith(
			scope,
			"abc123",
			takenClaim(instances),
		)
		expect(audit.record).not.toHaveBeenCalled()
	})

	it("gives the units longer to stop than each waits before killing its client", async () => {
		const transport = createFakeTransport()
		await removeOn(hostRow, transport).run()
		const templates = renderUnitTemplates(UNIT_RUNTIME)
		const stopSeconds = (unit: string) =>
			Number(/^TimeoutStopSec=(\d+)$/m.exec(templates[unit] ?? "")?.[1])
		const stopWait = transport.timeouts[transport.commands.indexOf(STEPS.stop)]

		expect(stopSeconds(INSTANCE_UNIT_NAME)).toBeGreaterThan(0)
		expect(stopSeconds(AUTH_UNIT_NAME)).toBeGreaterThan(0)
		expect(stopWait).toBeGreaterThan(2 * stopSeconds(INSTANCE_UNIT_NAME) * 1000)
		expect(stopWait).toBeGreaterThan(stopSeconds(AUTH_UNIT_NAME) * 1000)
	})

	it("issues no account command, and never kills or deletes by account", async () => {
		const transport = createFakeTransport()
		await removeOn(hostRow, transport).run()

		expect(
			transport.commands.filter(
				(command) =>
					command.includes("pkill") ||
					command.includes("useradd") ||
					command.includes("userdel") ||
					command.includes("groupdel") ||
					command.includes("-u 'mcc-"),
			),
		).toEqual([])
	})
})

describe("running several instances on one host", () => {
	it("gives each its own directory and its own unit, so they do not collide", () => {
		expect(instanceDir("alpha")).not.toBe(instanceDir("beta"))
		expect(unitName("alpha")).toBe("open-mcc@alpha")
		expect(unitName("beta")).toBe("open-mcc@beta")
	})

	it("keeps the port the row owns, whatever a config save asks for", async () => {
		const { deps, transport } = makeDeps()
		const documents: string[] = []
		deps.instances.insertConfigVersion = async (_scope, _id, document) => {
			documents.push(document)
			return configRow()
		}
		vi.mocked(deps.instances.latestConfig).mockResolvedValue(
			configRow({
				document: {
					accountType: "microsoft",
					minecraftAccount: "a@b.com",
					serverAddress: "play.example.net",
					autoRelogRetries: 3,
					autoRelogEnabled: true,
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
			}),
		)
		const controller = createInstanceController(deps)
		await controller.updateSettings(
			owner,
			"abc123",
			{
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
			},
			1,
		)

		const [document = ""] = transport.stdins

		expect(documents).toHaveLength(1)
		expect(JSON.parse(documents[0] ?? "{}").liveControlPort).toBe(33333)
		expect(transport.commands).toContain(configWriteCommand("abc123", document))
		expect(transport.commands.some((command) => /install -d|mkdir/.test(command))).toBe(false)
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
		const startedAt = transport.commands.findIndex((command) =>
			command.includes("systemctl --user start"),
		)
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

		expect(config?.config.liveControlPort).toBe(33333)
	})

	it("★ hands back the row's own version, not one it invents", async () => {
		const { deps } = makeDeps()
		deps.instances.latestConfig = async () =>
			configRow({ document: { ...SAVED_DOCUMENT }, version: 4 })
		const controller = createInstanceController(deps)

		const config = await controller.getConfig(owner, "abc123")

		expect(config?.version).toBe(4)
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
		expect(wroteEnv[0]).toMatch(/^MCC_MCP_AUTH_TOKEN=[0-9a-f]{32}\n$/)
	})

	it("seals the rotated token rather than writing it to the database in the clear", async () => {
		const { deps, instances } = makeDeps()
		deps.instances.latestConfig = async () => configRow({ document: { ...SAVED_DOCUMENT } })
		const controller = createInstanceController(deps)
		await controller.start(owner, "abc123")

		const sealedTokens = vi
			.mocked(instances.writeTokenUnderClaim)
			.mock.calls.map(([, , , sealed]) => sealed.ciphertext)
		expect(sealedTokens).toHaveLength(1)
		expect(sealedTokens[0]).not.toMatch(/^[0-9a-f]{32}$/)
		expect(instances.update).not.toHaveBeenCalled()
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

		await controller.updateBotConfig(
			owner,
			"abc123",
			{ botConfig: { "ChatBot.Alerts.Enabled": "true" }, advancedKeys: SAVED.advancedKeys },
			1,
		)

		const document = writtenDocument(instances)
		expect(document.botConfig).toEqual({ "ChatBot.Alerts.Enabled": "true" })
		expect(document.serverAddress).toBe("play.example.net")
		expect(document.advancedKeys).toEqual({ "ChatBot.AutoEat.Enabled": "true" })
		expect(document.worldDataEnabled).toBe(true)
	})

	it("★ writes the config to the host as well, not only to the database", async () => {
		const { deps, transport } = withSavedConfig()
		const controller = createInstanceController(deps)

		await controller.updateBotConfig(
			owner,
			"abc123",
			{ botConfig: { "ChatBot.Alerts.Enabled": "true" }, advancedKeys: SAVED.advancedKeys },
			1,
		)

		const written = transport.stdins.find((each) => each.includes("[ChatBot.Alerts]"))
		expect(written).toBeDefined()
		expect(written).toContain("Enabled = true")
	})

	it("★ records the write in the audit log, as the config change it is", async () => {
		const { deps, audit } = withSavedConfig()
		const controller = createInstanceController(deps)

		await controller.updateBotConfig(
			owner,
			"abc123",
			{ botConfig: { "ChatBot.Alerts.Enabled": "true" }, advancedKeys: SAVED.advancedKeys },
			1,
		)

		expect(audit.record).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: "instance.config.update", subjectId: "abc123" }),
		)
	})

	it("★ refuses a viewer before reading anything, not only before writing it", async () => {
		const { deps, instances } = withSavedConfig()
		const controller = createInstanceController(deps)

		await expect(
			controller.updateBotConfig(
				viewer,
				"abc123",
				{ botConfig: { "ChatBot.Alerts.Enabled": "true" }, advancedKeys: SAVED.advancedKeys },
				1,
			),
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
			controller.updateBotConfig(
				owner,
				"abc123",
				{ botConfig: { "ChatBot.Alerts.Enabled": "true" }, advancedKeys: SAVED.advancedKeys },
				1,
			),
		).rejects.toThrow(InstanceNotFoundError)
		expect(instances.insertConfigVersion).not.toHaveBeenCalled()
	})

	it("★ keeps the saved bots when the operator saves the settings that sit beside them", async () => {
		const { deps, instances } = withSavedConfig()
		const controller = createInstanceController(deps)
		const { botConfig: _bots, advancedKeys: _keys, ...settings } = SAVED

		await controller.updateSettings(
			owner,
			"abc123",
			{ ...settings, serverAddress: "moved.example.net" },
			1,
		)

		const document = writtenDocument(instances)
		expect(document.botConfig).toEqual({ "ChatBot.Alerts.Enabled": "false" })
		expect(document.serverAddress).toBe("moved.example.net")
	})

	it("★ keeps the saved advanced keys when the operator saves the settings beside them", async () => {
		const { deps, instances } = withSavedConfig()
		const controller = createInstanceController(deps)
		const { botConfig: _bots, advancedKeys: _keys, ...settings } = SAVED

		await controller.updateSettings(
			owner,
			"abc123",
			{ ...settings, serverAddress: "moved.example.net" },
			1,
		)

		const document = writtenDocument(instances)
		expect(document.advancedKeys).toEqual({ "ChatBot.AutoEat.Enabled": "true" })
		expect(document.serverAddress).toBe("moved.example.net")
	})

	it("★ writes the advanced keys it was given and keeps every setting it was not", async () => {
		const { deps, instances } = withSavedConfig()
		const controller = createInstanceController(deps)

		await controller.updateBotConfig(
			owner,
			"abc123",
			{
				botConfig: { "ChatBot.Alerts.Enabled": "true" },
				advancedKeys: { "ChatBot.AutoEat.Threshold": "9" },
			},
			1,
		)

		const document = writtenDocument(instances)
		expect(document.advancedKeys).toEqual({ "ChatBot.AutoEat.Threshold": "9" })
		expect(document.botConfig).toEqual({ "ChatBot.Alerts.Enabled": "true" })
		expect(document.serverAddress).toBe("play.example.net")
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
					botConfig: { "ChatBot.PlayerListLogger.File": "SessionCache.db" },
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
		expect((await controller.getConfig(owner, "abc123"))?.config.botConfig).toEqual({
			"ChatBot.PlayerListLogger.File": "SessionCache.db",
		})
	})

	it("★ refuses a Settings save while a saved bot file is refused as a Bots fault, not a Settings one", async () => {
		const { deps, instances } = withReservedBotFile()
		const controller = createInstanceController(deps)
		const { botConfig: _bots, advancedKeys: _keys, ...settings } = SAVED

		await expect(controller.updateSettings(owner, "abc123", settings, 1)).rejects.toBeInstanceOf(
			InstanceBotConfigUnusableError,
		)
		expect(instances.insertConfigVersion).not.toHaveBeenCalled()
	})

	it("★ still reports a safety edit on the host while a saved bot file name is refused", async () => {
		const { deps, transport } = withReservedBotFile()
		const onHost = renderInstanceConfig({
			...SAVED,
			botConfig: { "ChatBot.PlayerListLogger.File": "SessionCache.db" },
			liveControlPort: instanceRow().liveControlPort,
		}).replace("RequireAuthToken = true", "RequireAuthToken = false")
		const execUntil = transport.execUntil
		transport.execUntil = async (command, signal) =>
			command.startsWith("cat ") && command.includes("MinecraftClient.ini")
				? { stdout: onHost, stderr: "", exitCode: 0 }
				: await execUntil(command, signal)
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
		const { deps, transport, instances } = withUnusableSavedConfig()
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "stopped" }))
		const controller = createInstanceController(deps)

		await expect(controller.start(owner, "abc123")).rejects.toThrow(InstanceConfigUnusableError)
		expect(instances.claimForLifecycle).not.toHaveBeenCalled()
		expect(instances.writeTokenUnderClaim).not.toHaveBeenCalled()
		expect(transport.commands.filter((command) => command.includes("/env"))).toEqual([])
		expect(transport.stdins.filter((stdin) => stdin.includes("MCC_MCP_AUTH_TOKEN="))).toEqual([])
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

		expect(readable?.config.serverAddress).toBe("x/../../tmp")
	})

	it("★ and lets the next settings save replace that bad value", async () => {
		const { deps, instances } = withUnusableSavedConfig()
		const controller = createInstanceController(deps)
		const { botConfig: _bots, advancedKeys: _keys, ...settings } = SAVED

		await controller.updateSettings(
			owner,
			"abc123",
			{ ...settings, serverAddress: "play.example.net" },
			1,
		)

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
		transport.execUntil = async () => {
			throw new Error("Connection reset by peer")
		}
		const controller = createInstanceController(deps)

		const result = await controller.reconcileHost(owner, "host-1")

		expect(result.reachable).toBe(false)
	})

	it("★ gives the host connection back even when a saved document is unusable", async () => {
		const { deps, readConnections } = withUnusableSavedConfig()
		const controller = createInstanceController(deps)

		await controller.reconcileHost(owner, "host-1")

		expect(readConnections.activeLeases()).toBe(0)
	})

	it("★ refuses a settings save rather than silently emptying bots it could not read", async () => {
		const { deps, instances } = makeDeps()
		vi.mocked(instances.latestConfig).mockResolvedValue(configRow({ document: { nonsense: true } }))
		const controller = createInstanceController(deps)
		const { botConfig: _bots, advancedKeys: _keys, ...settings } = SAVED

		await expect(controller.updateSettings(owner, "abc123", settings, 1)).rejects.toThrow(
			InstanceConfigUnusableError,
		)
		expect(instances.insertConfigVersion).not.toHaveBeenCalled()
	})

	it("★ refuses a config the merge composed that the contract would not accept", async () => {
		const { deps, instances } = makeDeps()
		vi.mocked(instances.latestConfig).mockResolvedValue(
			configRow({
				document: { ...JSON.parse(JSON.stringify(SAVED)), serverAddress: "a/../../etc" },
			}),
		)
		const controller = createInstanceController(deps)

		await expect(
			controller.updateBotConfig(
				owner,
				"abc123",
				{ botConfig: { "ChatBot.Alerts.Enabled": "true" }, advancedKeys: SAVED.advancedKeys },
				1,
			),
		).rejects.toThrow()
		expect(instances.insertConfigVersion).not.toHaveBeenCalled()
		expect(instances.releaseConfigClaim).toHaveBeenCalled()
	})

	it("refuses an instance with nothing saved rather than inventing a config around the bots", async () => {
		const { deps, instances } = makeDeps()
		const controller = createInstanceController(deps)

		await expect(
			controller.updateBotConfig(
				owner,
				"abc123",
				{ botConfig: { "ChatBot.Alerts.Enabled": "true" }, advancedKeys: SAVED.advancedKeys },
				1,
			),
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
				renderUnitTemplates(UNIT_RUNTIME)[INSTANCE_UNIT_NAME] ?? "",
			)?.[1],
		)

		await controller.stop(owner, "abc123")

		const stopAt = transport.commands.findIndex((each) => each.includes("stop 'open-mcc@abc123'"))
		expect(stopSeconds).toBeGreaterThan(0)
		expect(stopAt).toBeGreaterThanOrEqual(0)
		expect(transport.timeouts[stopAt]).toBeGreaterThan(2 * stopSeconds * 1000)
	})

	it("refuses a stop while another change holds the bot, without reaching its host", async () => {
		const { deps, transport, instances } = makeDeps()
		vi.mocked(instances.claimForLifecycle).mockResolvedValue(undefined)
		const connect = vi.spyOn(transport, "connect")

		await expect(createInstanceController(deps).stop(owner, "abc123")).rejects.toBeInstanceOf(
			InstanceBusyError,
		)

		expect(connect).not.toHaveBeenCalled()
		expect(transport.commands).toEqual([])
	})

	it("says the bot is stopped in the same statement that gives its claim back", async () => {
		const { deps, instances } = makeDeps()

		await createInstanceController(deps).stop(owner, "abc123")

		expect(instances.claimForLifecycle).toHaveBeenCalledTimes(1)
		expect(instances.finalizeConfigClaim).toHaveBeenCalledWith(
			expect.anything(),
			"abc123",
			vi.mocked(instances.claimForLifecycle).mock.calls[0]?.[2],
			{ status: "stopped" },
		)
		expect(instances.update).not.toHaveBeenCalled()
	})

	it("never says a bot is stopped when systemd refused to stop it", async () => {
		const { deps, transport, instances } = makeDeps()
		const stop = `${SYSTEMCTL} stop 'open-mcc@abc123'`
		const inner = transport.exec
		transport.exec = async (command, timeoutMs, stdin) => {
			const result = await inner(command, timeoutMs, stdin)
			return command === stop
				? { stdout: "", stderr: "Job for open-mcc@abc123.service failed", exitCode: 1 }
				: result
		}

		await expect(createInstanceController(deps).stop(owner, "abc123")).rejects.toThrow(
			/Failed to stop instance abc123/,
		)

		expect(instances.finalizeConfigClaim).not.toHaveBeenCalled()
		expect(instances.releaseConfigClaim).toHaveBeenCalled()
	})

	it("never rewrites a bot's token when the stop a restart begins with was refused", async () => {
		const { deps, transport, instances } = makeDeps()
		vi.mocked(deps.instances.latestConfig).mockResolvedValue(
			configRow({ document: { ...SAVED_DOCUMENT } }),
		)
		const stop = `${SYSTEMCTL} stop 'open-mcc@abc123'`
		const inner = transport.exec
		transport.exec = async (command, timeoutMs, stdin) => {
			const result = await inner(command, timeoutMs, stdin)
			return command === stop
				? { stdout: "", stderr: "Job for open-mcc@abc123.service failed", exitCode: 1 }
				: result
		}

		await expect(createInstanceController(deps).restart(owner, "abc123")).rejects.toThrow(
			/Failed to stop instance abc123/,
		)

		expect(transport.commands).toEqual([stop])
		expect(instances.writeTokenUnderClaim).not.toHaveBeenCalled()
		expect(instances.finalizeConfigClaim).not.toHaveBeenCalled()
		expect(instances.releaseConfigClaim).toHaveBeenCalled()
	})
})

describe("a bot on a host whose Repair setup did not finish", () => {
	const setUpOnce = (status: HostRow["status"]): HostRow => ({
		...hostRow,
		status,
		osRelease: "systemd 252",
	})

	const onHost = (host: HostRow) => makeDeps({ hosts: { findById: vi.fn(async () => host) } })

	it.each(["error", "provisioning"] as const)(
		"can still be stopped while the host is %s after a repair",
		async (status) => {
			const { deps, transport } = onHost(setUpOnce(status))

			await createInstanceController(deps).stop(owner, "abc123")

			expect(transport.commands.some((each) => each.includes("stop 'open-mcc@abc123'"))).toBe(true)
		},
	)

	it("can still be removed, its row deleted, after a repair failed", async () => {
		const { deps, transport, instances } = onHost(setUpOnce("error"))

		await createInstanceController(deps).remove(owner, "abc123")

		expect(transport.commands).toContain(deleteDirectoryCommand("abc123"))
		expect(instances.deleteUnderClaim).toHaveBeenCalledTimes(1)
	})

	it("is not joined by a new bot until a repair succeeds, and the host is never reached", async () => {
		const { deps, transport, instances } = onHost(setUpOnce("error"))

		await expect(
			createInstanceController(deps).create(owner, {
				hostId: "host-1",
				name: "afk-2",
				accountType: "microsoft",
				minecraftAccount: "afk@example.com",
				serverAddress: "play.example.com",
			}),
		).rejects.toBeInstanceOf(InstanceHostNotProvisionedError)
		expect(transport.commands).toEqual([])
		expect(instances.insert).not.toHaveBeenCalled()
	})

	it("is refused on a host that was never set up, before the host is reached", async () => {
		const { deps, transport } = onHost({ ...hostRow, status: "error", osRelease: null })

		await expect(createInstanceController(deps).stop(owner, "abc123")).rejects.toBeInstanceOf(
			InstanceHostNotProvisionedError,
		)
		expect(transport.commands).toEqual([])
	})
})

describe("a bot on a host with no recorded runtime", () => {
	const onHostWithout = (missing: Partial<HostRow>) => {
		const made = makeDeps({ hosts: { findById: vi.fn(async () => ({ ...hostRow, ...missing })) } })
		vi.mocked(made.instances.findById).mockResolvedValue(instanceRow({ status: "running" }))
		const connect = vi.spyOn(made.transport, "connect")
		return { ...made, connect }
	}

	type Controller = ReturnType<typeof createInstanceController>

	const RUNTIME_PATHS = [
		[
			"a start",
			async (controller: Controller) => {
				await controller.start(owner, "abc123")
			},
		],
		[
			"a restart",
			async (controller: Controller) => {
				await controller.restart(owner, "abc123")
			},
		],
		[
			"a console command",
			async (controller: Controller) => {
				await controller.sendCommand(owner, "abc123", "/say hello")
			},
		],
		[
			"a scheduled command",
			async (controller: Controller) => {
				await controller.runScheduledCommand(commandRow())
			},
		],
		[
			"a console read",
			async (controller: Controller) => {
				await controller.readConsole(owner, "abc123", 20)
			},
		],
		[
			"a new bot",
			async (controller: Controller) => {
				await controller.create(owner, {
					hostId: "host-1",
					name: "afk-2",
					accountType: "microsoft",
					minecraftAccount: "afk@example.com",
					serverAddress: "play.example.com",
				})
			},
		],
	] as const

	describe.each([
		["no network stack", { networkStack: null }],
		["no architecture", { architecture: null }],
	] as const)("recording %s", (_case, missing) => {
		it.each(RUNTIME_PATHS)("refuses %s before connecting to the host", async (_path, run) => {
			const { deps, transport, connect, instances } = onHostWithout(missing)

			await expect(run(createInstanceController(deps))).rejects.toBeInstanceOf(
				InstanceHostNotProvisionedError,
			)
			expect(connect).not.toHaveBeenCalled()
			expect(transport.commands).toEqual([])
			expect(instances.insert).not.toHaveBeenCalled()
			expect(instances.update).not.toHaveBeenCalled()
		})

		it("reports the host as not set up to reconcile, and never connects to it", async () => {
			const { deps, transport, connect } = onHostWithout(missing)

			await expect(createInstanceController(deps).reconcileHost(owner, "host-1")).resolves.toEqual({
				hostId: "host-1",
				reachable: false,
				reason: "unprovisioned",
			})
			expect(connect).not.toHaveBeenCalled()
			expect(transport.commands).toEqual([])
		})

		it("can still be stopped", async () => {
			const { deps, transport } = onHostWithout(missing)

			await createInstanceController(deps).stop(owner, "abc123")

			expect(transport.commands.some((each) => each.includes("stop 'open-mcc@abc123'"))).toBe(true)
		})

		it("can still be removed, its row deleted", async () => {
			const { deps, transport, instances } = onHostWithout(missing)

			await createInstanceController(deps).remove(owner, "abc123")

			expect(transport.commands).toContain(deleteDirectoryCommand("abc123"))
			expect(instances.deleteUnderClaim).toHaveBeenCalledTimes(1)
		})
	})
})

describe("the token goes only to a bot seen running", () => {
	const ACTIVE_CHECK = `${SYSTEMCTL} is-active --quiet 'open-mcc@abc123.service'`
	const SIGN_IN_LOG =
		"To sign in, open https://www.microsoft.com/link in your browser and enter the code: FJDPTLX8\n"
	const TOKEN = "31337token"
	const authorizations: (string | undefined)[] = []
	let client: Server
	let clientPort = 0

	beforeAll(async () => {
		client = createServer((request, response) => {
			authorizations.push(request.headers.authorization)
			request.resume()
			request.on("end", () => response.writeHead(401).end())
		})
		await new Promise<void>((resolve) => client.listen(0, "127.0.0.1", resolve))
		const address = client.address()
		clientPort = address !== null && typeof address === "object" ? address.port : 0
	})

	afterAll(async () => {
		await new Promise<void>((resolve) => client.close(() => resolve()))
	})

	const liveBot = (running: { exitCode: number }, clock: { at: number }) => {
		authorizations.length = 0
		const made = makeDeps({
			now: () => clock.at,
			secrets: {
				open: () => TOKEN,
				seal: (plaintext: string) => ({ ciphertext: `sealed(${plaintext.length})`, keyId: "k1" }),
				activeKeyId: "k1",
			},
		})
		made.deps.instances.findById = async () =>
			instanceRow({
				liveControlPort: 33350,
				liveControlTokenEncrypted: "sealed(32)",
				liveControlTokenKeyId: "k1",
			})
		made.deps.instances.latestConfig = async () =>
			configRow({
				document: { ...SAVED_DOCUMENT, liveControlEnabled: true, liveControlPort: 33350 },
			})
		const checks: string[] = []
		const opened: string[] = []
		const { transport } = made
		const execUntil = transport.execUntil
		transport.execUntil = async (command: string, signal: AbortSignal) => {
			if (command !== ACTIVE_CHECK) return await execUntil(command, signal)
			checks.push("shared")
			return { stdout: "", stderr: "", exitCode: running.exitCode }
		}
		const exec = transport.exec
		transport.exec = async (command: string, timeoutMs: number, stdin?: string) => {
			if (command.endsWith("/auth.log 2>/dev/null || true")) {
				return { stdout: SIGN_IN_LOG, stderr: "", exitCode: 0 }
			}
			if (command !== ACTIVE_CHECK) return await exec(command, timeoutMs, stdin)
			checks.push("fresh")
			return { stdout: "", stderr: "", exitCode: running.exitCode }
		}
		const toClient = (via: string) => async (port: number) => {
			opened.push(`${via}:${port}`)
			const socket = connect(clientPort, "127.0.0.1")
			return { socket, close: () => socket.destroy() }
		}
		transport.forwardUntil = toClient("shared")
		transport.forward = toClient("fresh")
		return { ...made, controller: createInstanceController(made.deps), checks, opened }
	}

	it("issues no is-active for a second readout within 5 seconds of an active result", async () => {
		const clock = { at: 1_000_000 }
		const { controller, checks } = liveBot({ exitCode: 0 }, clock)

		expect(await controller.readLivePlayerStats(owner, "abc123")).toEqual(
			READER_RESULTS.readPlayerStats,
		)
		clock.at += 4_999
		expect(await controller.readLivePlayerStats(owner, "abc123")).toEqual(
			READER_RESULTS.readPlayerStats,
		)

		expect(checks).toEqual(["shared"])
	})

	it("issues one again for a readout 5 seconds after that result", async () => {
		const clock = { at: 1_000_000 }
		const { controller, checks } = liveBot({ exitCode: 0 }, clock)

		await controller.readLivePlayerStats(owner, "abc123")
		clock.at += 5_000
		await controller.readLivePlayerStats(owner, "abc123")

		expect(checks).toEqual(["shared", "shared"])
	})

	it("opens no forward and sends no token once the bot is not running, though it was before", async () => {
		const running = { exitCode: 0 }
		const clock = { at: 1_000_000 }
		const { controller, checks, opened, audit, readConnections } = liveBot(running, clock)
		await controller.readLiveStatus(owner, "abc123").catch(() => undefined)
		expect(authorizations).toEqual([`Bearer ${TOKEN}`])
		expect(opened).toEqual(["shared:33350"])

		running.exitCode = 3
		clock.at += 5_000
		authorizations.length = 0
		opened.length = 0
		await expect(controller.readLiveStatus(owner, "abc123")).resolves.toBeUndefined()
		await expect(
			controller.dropInventoryItem(owner, "abc123", "minecraft:dirt", 1),
		).rejects.toBeInstanceOf(LiveChannelUnavailableError)

		expect(opened).toEqual([])
		expect(authorizations).toEqual([])
		expect(checks).toEqual(["shared", "shared", "fresh"])
		expect(audit.record).not.toHaveBeenCalled()
		expect(readConnections.activeLeases()).toBe(0)
	})

	it("asks once for readouts that arrive together", async () => {
		const { controller, checks, transport } = liveBot({ exitCode: 0 }, { at: 1_000_000 })
		const answered = transport.execUntil
		transport.execUntil = async (command: string, signal: AbortSignal) => {
			await new Promise((resolve) => setImmediate(resolve))
			return await answered(command, signal)
		}

		const outcomes = await Promise.all([
			controller.readLivePlayerStats(owner, "abc123"),
			controller.readLiveStatusEffects(owner, "abc123"),
			controller.readLiveBots(owner, "abc123"),
			controller.readLivePlayers(owner, "abc123"),
		])

		expect(outcomes).toEqual([
			READER_RESULTS.readPlayerStats,
			READER_RESULTS.readStatusEffects,
			READER_RESULTS.readLoadedBots,
			READER_RESULTS.readPlayersList,
		])
		expect(checks).toEqual(["shared"])
	})

	it("asks on the connection each request forwards over", async () => {
		const clock = { at: 1_000_000 }
		const { controller, checks, opened } = liveBot({ exitCode: 0 }, clock)

		await controller.readLiveStatus(owner, "abc123").catch(() => undefined)
		clock.at += 5_000
		await controller.dropInventoryItem(owner, "abc123", "minecraft:dirt", 1).catch(() => undefined)

		expect(checks).toEqual(["shared", "fresh"])
		expect(opened).toEqual(["shared:33350", "fresh:33350"])
	})

	it.each([
		{ named: "its host key", changed: { hostKeyFingerprint: "SHA256:replaced" } },
		{ named: "its address", changed: { hostname: "10.0.0.2" } },
		{ named: "its SSH port", changed: { port: 2222 } },
		{ named: "its account", changed: { username: "other" } },
		{ named: "its SSH key", changed: { sshKeyId: "key-2" } },
	])("asks again within 5 seconds once the host changes $named", async ({ changed }) => {
		const clock = { at: 1_000_000 }
		const { controller, checks, deps } = liveBot({ exitCode: 0 }, clock)

		await controller.readLivePlayerStats(owner, "abc123")
		deps.hosts.findById = async () => ({ ...hostRow, ...changed })
		clock.at += 1_000
		await controller.readLivePlayerStats(owner, "abc123")

		expect(checks).toEqual(["shared", "shared"])
	})

	type LiveController = ReturnType<typeof createInstanceController>

	it.each([
		{
			named: "a stop",
			run: async (controller: LiveController) => {
				await controller.stop(owner, "abc123")
			},
		},
		{
			named: "a restart",
			run: async (controller: LiveController) => {
				await controller.restart(owner, "abc123")
			},
		},
		{
			named: "a removal",
			run: async (controller: LiveController) => {
				await controller.remove(owner, "abc123")
			},
		},
		{
			named: "a sign-in, which stops the bot first",
			run: async (controller: LiveController) => {
				await controller.authenticate(owner, "abc123")
			},
		},
	])("asks again within 5 seconds after $named", async ({ run }) => {
		const clock = { at: 1_000_000 }
		const { controller, checks } = liveBot({ exitCode: 0 }, clock)

		await controller.readLivePlayerStats(owner, "abc123")
		await run(controller)
		clock.at += 1_000
		await controller.readLivePlayerStats(owner, "abc123")

		expect(checks).toEqual(["shared", "shared"])
	})
})

describe("saving settings under a claim", () => {
	const { botConfig: _savedBots, advancedKeys: _savedKeys, ...SAVED_SETTINGS } = SAVED_DOCUMENT
	const SETTINGS = instanceSettingsInput.parse(SAVED_SETTINGS)

	const NEW_BOT = {
		hostId: "host-1",
		name: "afk-2",
		accountType: "offline",
		minecraftAccount: "afk",
		serverAddress: "play.example.com",
	} as const

	const BOTS = { botConfig: { "ChatBot.Alerts.Enabled": "true" }, advancedKeys: {} }

	const savedDeps = () => {
		const made = makeDeps()
		vi.mocked(made.instances.latestConfig).mockResolvedValue(
			configRow({ document: { ...SAVED_DOCUMENT } }),
		)
		return made
	}

	type Save = (
		controller: ReturnType<typeof createInstanceController>,
	) => Promise<{ version: number }>

	const SAVES: Array<{ named: string; run: Save }> = [
		{
			named: "a settings save",
			run: (controller) => controller.updateSettings(owner, "abc123", SETTINGS, 1),
		},
		{
			named: "a bots save",
			run: (controller) => controller.updateBotConfig(owner, "abc123", BOTS, 1),
		},
	]

	type Claimed = (controller: ReturnType<typeof createInstanceController>) => Promise<void>

	const CLAIMED: Array<{ named: string; run: Claimed }> = [
		...SAVES.map(({ named, run }) => ({
			named,
			run: async (controller: ReturnType<typeof createInstanceController>) => {
				await run(controller)
			},
		})),
		{
			named: "a removal",
			run: async (controller) => {
				await controller.remove(owner, "abc123")
			},
		},
		{
			named: "a start",
			run: async (controller) => {
				await controller.start(owner, "abc123")
			},
		},
		{
			named: "a restart",
			run: async (controller) => {
				await controller.restart(owner, "abc123")
			},
		},
		{
			named: "a stop",
			run: async (controller) => {
				await controller.stop(owner, "abc123")
			},
		},
		{
			named: "a create",
			run: async (controller) => {
				await controller.create(owner, NEW_BOT)
			},
		},
	]

	const recordingInstances = (inner: InstanceRepository, note: () => void): InstanceRepository => ({
		insert: (...args) => {
			note()
			return inner.insert(...args)
		},
		findById: (...args) => {
			note()
			return inner.findById(...args)
		},
		list: (...args) => {
			note()
			return inner.list(...args)
		},
		update: (...args) => {
			note()
			return inner.update(...args)
		},
		delete: (...args) => {
			note()
			return inner.delete(...args)
		},
		claimForAuth: (...args) => {
			note()
			return inner.claimForAuth(...args)
		},
		releaseAuthClaim: (...args) => {
			note()
			return inner.releaseAuthClaim(...args)
		},
		claimForConfig: (...args) => {
			note()
			return inner.claimForConfig(...args)
		},
		claimForLifecycle: (...args) => {
			note()
			return inner.claimForLifecycle(...args)
		},
		finalizeConfigClaim: (...args) => {
			note()
			return inner.finalizeConfigClaim(...args)
		},
		releaseConfigClaim: (...args) => {
			note()
			return inner.releaseConfigClaim(...args)
		},
		writeTokenUnderClaim: (...args) => {
			note()
			return inner.writeTokenUnderClaim(...args)
		},
		deleteUnderClaim: (...args) => {
			note()
			return inner.deleteUnderClaim(...args)
		},
		insertConfigVersion: (...args) => {
			note()
			return inner.insertConfigVersion(...args)
		},
		latestConfig: (...args) => {
			note()
			return inner.latestConfig(...args)
		},
	})

	it.each(CLAIMED)(
		"never reads the pool repository inside a transaction during $named",
		async ({ run }) => {
			const made = savedDeps()
			let open = 0
			const sightings: boolean[] = []
			const note = () => sightings.push(open > 0)
			const deps: InstanceControllerDeps = {
				...made.deps,
				instances: recordingInstances(made.instances, note),
				hosts: {
					findById: (...args) => {
						note()
						return made.deps.hosts.findById(...args)
					},
				},
				sshKeys: {
					findById: (...args) => {
						note()
						return made.deps.sshKeys.findById(...args)
					},
				},
				withTransaction: async (fn) => {
					open += 1
					try {
						return await made.deps.withTransaction(fn)
					} finally {
						open -= 1
					}
				},
			}

			await run(createInstanceController(deps))

			expect(sightings.length).toBeGreaterThan(0)
			expect(sightings.filter((inside) => inside)).toEqual([])
		},
	)

	it.each(CLAIMED)("never touches the host inside a transaction during $named", async ({ run }) => {
		const made = savedDeps()
		let open = 0
		const sightings: boolean[] = []
		const inner = made.transport
		const deps: InstanceControllerDeps = {
			...made.deps,
			createTransport: () => ({
				...inner,
				connect: async (options) => {
					sightings.push(open > 0)
					await inner.connect(options)
				},
				exec: async (command, timeoutMs, stdin) => {
					sightings.push(open > 0)
					return await inner.exec(command, timeoutMs, stdin)
				},
				canForward: async (port, timeoutMs) => {
					sightings.push(open > 0)
					return await inner.canForward(port, timeoutMs)
				},
			}),
			withTransaction: async (fn) => {
				open += 1
				try {
					return await made.deps.withTransaction(fn)
				} finally {
					open -= 1
				}
			},
		}

		await run(createInstanceController(deps))

		expect(sightings.length).toBeGreaterThan(0)
		expect(sightings.filter((inside) => inside)).toEqual([])
	})

	const remoteWaitsUnderClaim = async (
		run: (controller: ReturnType<typeof createInstanceController>) => Promise<void>,
	): Promise<number[]> => {
		const made = savedDeps()
		let claimed = false
		const waits: number[] = []
		const config = made.instances.claimForConfig
		made.instances.claimForConfig = async (...args) => {
			const row = await config(...args)
			claimed = true
			return row
		}
		const lifecycle = made.instances.claimForLifecycle
		made.instances.claimForLifecycle = async (...args) => {
			const row = await lifecycle(...args)
			claimed = true
			return row
		}
		const insert = made.instances.insert
		made.instances.insert = async (...args) => {
			const row = await insert(...args)
			claimed = true
			return row
		}
		const finalize = made.instances.finalizeConfigClaim
		made.instances.finalizeConfigClaim = async (...args) => {
			claimed = false
			return await finalize(...args)
		}
		const inner = made.transport
		const deps: InstanceControllerDeps = {
			...made.deps,
			createTransport: () => ({
				...inner,
				connect: async (options) => {
					if (claimed) waits.push(options.timeoutMs)
					await inner.connect(options)
				},
				exec: async (command, timeoutMs, stdin) => {
					if (claimed) waits.push(timeoutMs)
					return await inner.exec(command, timeoutMs, stdin)
				},
			}),
		}

		await run(createInstanceController(deps))
		return waits
	}

	it.each([
		{
			named: "a settings save",
			budget: 25_000,
			run: async (controller: ReturnType<typeof createInstanceController>) => {
				await controller.updateSettings(owner, "abc123", SETTINGS, 1)
			},
		},
		{
			named: "a start",
			budget: 55_000,
			run: async (controller: ReturnType<typeof createInstanceController>) => {
				await controller.start(owner, "abc123")
			},
		},
		{
			named: "a stop",
			budget: 55_000,
			run: async (controller: ReturnType<typeof createInstanceController>) => {
				await controller.stop(owner, "abc123")
			},
		},
		{
			named: "a restart",
			budget: 100_000,
			run: async (controller: ReturnType<typeof createInstanceController>) => {
				await controller.restart(owner, "abc123")
			},
		},
		{
			named: "a create",
			budget: 60_000,
			run: async (controller: ReturnType<typeof createInstanceController>) => {
				await controller.create(owner, NEW_BOT)
			},
		},
	])(
		"spends $budget ms of remote work under the claim during $named, far less than the lease",
		async ({ budget, run }) => {
			const waits = await remoteWaitsUnderClaim(run)

			const spent = waits.reduce((total, wait) => total + wait, 0)
			expect(spent).toBe(budget)
			expect(spent).toBeLessThan(CONFIG_CLAIM_LEASE_MS)
		},
	)

	it("waits longer for a restart's stop than the unit waits before killing the client", async () => {
		const stopSeconds = Number(
			/^TimeoutStopSec=(\d+)$/m.exec(
				renderUnitTemplates(UNIT_RUNTIME)[INSTANCE_UNIT_NAME] ?? "",
			)?.[1],
		)

		const waits = await remoteWaitsUnderClaim(async (controller) => {
			await controller.restart(owner, "abc123")
		})

		expect(stopSeconds).toBeGreaterThan(0)
		expect(Math.max(...waits)).toBeGreaterThan(2 * stopSeconds * 1000)
	})

	const failingWrite = (
		made: ReturnType<typeof savedDeps>,
		outcome: { resolves: number } | { rejects: Error },
	) => {
		const inner = made.transport.exec
		made.transport.exec = async (command, timeoutMs, stdin) => {
			if (!command.includes("MinecraftClient.ini")) return await inner(command, timeoutMs, stdin)
			if ("rejects" in outcome) throw outcome.rejects
			return { stdout: "", stderr: "refused", exitCode: outcome.resolves }
		}
	}

	it.each([
		{ named: "an exit status of 1", outcome: { resolves: 1 }, released: true },
		{ named: "a deadline's exit status of 124", outcome: { resolves: 124 }, released: true },
		{
			named: "a refused session channel",
			outcome: { rejects: new ChannelLimitReachedError("no channel") },
			released: true,
		},
		{
			named: "a command that timed out",
			outcome: { rejects: new CommandTimedOutError("too slow") },
			released: false,
		},
		{
			named: "ssh2's Unable to exec",
			outcome: { rejects: new Error("Unable to exec") },
			released: false,
		},
		{
			named: "a channel closed with no exit status",
			outcome: { rejects: new CommandAbortedError("write", undefined) },
			released: false,
		},
		{
			named: "a channel killed by a signal",
			outcome: { rejects: new CommandAbortedError("write", "KILL") },
			released: false,
		},
		{
			named: "a channel that opened too late",
			outcome: { rejects: new ChannelOpenTimedOutError("too slow") },
			released: false,
		},
	])("$named leaves the claim released=$released", async ({ outcome, released }) => {
		const made = savedDeps()
		failingWrite(made, outcome)

		await expect(
			createInstanceController(made.deps).updateSettings(owner, "abc123", SETTINGS, 1),
		).rejects.toThrow()

		expect(vi.mocked(made.instances.releaseConfigClaim).mock.calls.length > 0).toBe(released)
		expect(made.instances.insertConfigVersion).not.toHaveBeenCalled()
	})

	it("releases the claim when the host refuses the connection, because nothing was sent", async () => {
		const made = savedDeps()
		const deps: InstanceControllerDeps = {
			...made.deps,
			createTransport: () => ({
				...made.transport,
				connect: async () => {
					throw new Error("Connection refused")
				},
			}),
		}

		await expect(
			createInstanceController(deps).updateSettings(owner, "abc123", SETTINGS, 1),
		).rejects.toBeInstanceOf(HostUnreachableError)

		expect(made.instances.releaseConfigClaim).toHaveBeenCalled()
	})

	it("refuses a save whose bot is already claimed, without touching the host", async () => {
		const made = savedDeps()
		vi.mocked(made.instances.claimForConfig).mockResolvedValue(undefined)

		await expect(
			createInstanceController(made.deps).updateSettings(owner, "abc123", SETTINGS, 1),
		).rejects.toBeInstanceOf(InstanceBusyError)

		expect(made.transport.stdins).toEqual([])
	})

	it("refuses a save made against a version someone else has already replaced", async () => {
		const made = savedDeps()
		vi.mocked(made.instances.latestConfig).mockResolvedValue(
			configRow({ document: { ...SAVED_DOCUMENT }, version: 2 }),
		)

		await expect(
			createInstanceController(made.deps).updateSettings(owner, "abc123", SETTINGS, 1),
		).rejects.toBeInstanceOf(InstanceConcurrentlyModifiedError)

		expect(made.transport.stdins).toEqual([])
		expect(made.instances.insertConfigVersion).not.toHaveBeenCalled()
	})

	it("reports a bot that was removed as gone, not as busy", async () => {
		const made = savedDeps()
		vi.mocked(made.instances.claimForConfig).mockResolvedValue(undefined)
		vi.mocked(made.instances.findById).mockResolvedValueOnce(instanceRow())
		vi.mocked(made.instances.findById).mockResolvedValue(undefined)

		await expect(
			createInstanceController(made.deps).updateSettings(owner, "abc123", SETTINGS, 1),
		).rejects.toBeInstanceOf(InstanceNotFoundError)
	})

	it("refuses to record a version once the claim it wrote under was lost", async () => {
		const made = savedDeps()
		vi.mocked(made.instances.finalizeConfigClaim).mockResolvedValue(undefined)

		await expect(
			createInstanceController(made.deps).updateSettings(owner, "abc123", SETTINGS, 1),
		).rejects.toBeInstanceOf(InstanceBusyError)

		expect(made.instances.insertConfigVersion).not.toHaveBeenCalled()
	})
})

describe("creating a bot under its claim", () => {
	const NEW_BOT = {
		hostId: "host-1",
		name: "afk-2",
		accountType: "offline",
		minecraftAccount: "afk",
		serverAddress: "play.example.com",
	} as const

	const LAYOUT = instanceLayoutSteps({
		instanceId: "abc123",
		liveControlPort: 33334,
		liveControlToken: "0".repeat(32),
		configDocument: "[Main]\n",
	})

	const failingStep = (
		made: ReturnType<typeof makeDeps>,
		index: number,
		outcome: { resolves: number } | { rejects: Error },
	): string[] => {
		const issued: string[] = []
		const inner = made.transport.exec
		made.transport.exec = async (command, timeoutMs, stdin) => {
			issued.push(command)
			if (issued.length - 1 !== index) return await inner(command, timeoutMs, stdin)
			if ("rejects" in outcome) throw outcome.rejects
			return { stdout: "", stderr: "refused", exitCode: outcome.resolves }
		}
		return issued
	}

	const claimOf = (made: ReturnType<typeof makeDeps>): string | undefined =>
		vi.mocked(made.instances.insert).mock.calls[0]?.[2]

	it("claims the row in the statement that inserts it, then gives that same claim back", async () => {
		const made = makeDeps()

		await createInstanceController(made.deps).create(owner, NEW_BOT)

		expect(claimOf(made)).toEqual(expect.any(String))
		expect(made.instances.finalizeConfigClaim).toHaveBeenCalledWith(
			{ organizationId: owner.organizationId },
			"abc123",
			claimOf(made),
			{},
		)
		expect(made.instances.releaseConfigClaim).not.toHaveBeenCalled()
		expect(made.transport.commands).toHaveLength(LAYOUT.length)
	})

	it("opens one transaction, for the insert, and finalizes on the pool beside it", async () => {
		const made = makeDeps()
		let opened = 0
		const deps: InstanceControllerDeps = {
			...made.deps,
			withTransaction: async (fn) => {
				opened += 1
				return await made.deps.withTransaction(fn)
			},
		}

		await createInstanceController(deps).create(owner, NEW_BOT)

		expect(opened).toBe(1)
		expect(made.instances.finalizeConfigClaim).toHaveBeenCalledTimes(1)
	})

	it("mints a claim of its own for each bot, so two creations cannot share one", async () => {
		const first = makeDeps()
		const second = makeDeps()

		await createInstanceController(first.deps).create(owner, NEW_BOT)
		await createInstanceController(second.deps).create(owner, NEW_BOT)

		expect(claimOf(first)).not.toBe(claimOf(second))
	})

	it.each(LAYOUT.map(({ failure }, index) => ({ index, failure })))(
		"stops at step $index, $failure, and releases the claim it took",
		async ({ index, failure }) => {
			const made = makeDeps()
			const issued = failingStep(made, index, { resolves: 1 })

			await expect(createInstanceController(made.deps).create(owner, NEW_BOT)).rejects.toThrow(
				failure,
			)

			expect(issued).toHaveLength(index + 1)
			expect(made.instances.finalizeConfigClaim).not.toHaveBeenCalled()
			expect(made.instances.releaseConfigClaim).toHaveBeenCalledWith(
				{ organizationId: owner.organizationId },
				"abc123",
				claimOf(made),
			)
		},
	)

	it.each([
		{
			named: "a refused session channel",
			outcome: { rejects: new ChannelLimitReachedError("no channel") },
			released: true,
		},
		{
			named: "a command that timed out",
			outcome: { rejects: new CommandTimedOutError("too slow") },
			released: false,
		},
		{
			named: "a channel that opened too late",
			outcome: { rejects: new ChannelOpenTimedOutError("too slow") },
			released: false,
		},
	])("leaves a layout step ending in $named released=$released", async ({ outcome, released }) => {
		const made = makeDeps()
		failingStep(made, 2, outcome)

		await expect(createInstanceController(made.deps).create(owner, NEW_BOT)).rejects.toThrow()

		expect(vi.mocked(made.instances.releaseConfigClaim).mock.calls.length > 0).toBe(released)
		expect(made.instances.finalizeConfigClaim).not.toHaveBeenCalled()
	})

	it("refuses to call a bot created once the claim it was built under was lost", async () => {
		const made = makeDeps()
		vi.mocked(made.instances.finalizeConfigClaim).mockResolvedValue(undefined)

		await expect(createInstanceController(made.deps).create(owner, NEW_BOT)).rejects.toBeInstanceOf(
			InstanceBusyError,
		)
	})

	it("inserts nothing, and releases nothing, when the host will not take the connection", async () => {
		const made = makeDeps()
		const deps: InstanceControllerDeps = {
			...made.deps,
			createTransport: () => ({
				...made.transport,
				connect: async () => {
					throw new Error("Connection refused")
				},
			}),
		}

		await expect(createInstanceController(deps).create(owner, NEW_BOT)).rejects.toBeInstanceOf(
			HostUnreachableError,
		)

		expect(made.instances.insert).not.toHaveBeenCalled()
		expect(made.instances.releaseConfigClaim).not.toHaveBeenCalled()
	})
})

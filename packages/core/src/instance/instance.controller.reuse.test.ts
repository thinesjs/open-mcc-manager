import { createServer, type Server } from "node:http"
import { connect } from "node:net"
import type {
	AuditEventRow,
	HostRow,
	InstanceCommandRow,
	InstanceConfigRow,
	InstanceRow,
	SshKeyRow,
} from "@open-mcc/db"
import {
	createFakeTransport,
	createReadConnections,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
	type ReusableTransport,
} from "@open-mcc/transport"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { AuditEntry, AuditRepository } from "../audit/audit.repository"
import type { OrgScope } from "../host/host.repository"
import type { CommandRepository } from "./command.repository"
import {
	type ActorContext,
	createInstanceController,
	InstanceHostNotFoundError,
	InstanceNotFoundError,
} from "./instance.controller"
import type { InstanceRepository } from "./instance.repository"
import type { ScheduleRepository } from "./schedule.repository"
import { instanceDir } from "./unit"

const owner: ActorContext = {
	organizationId: "org-1",
	memberId: "member-1",
	actorLabel: "owner@example.com",
	role: "owner",
}

const outsider: ActorContext = { ...owner, organizationId: "org-2" }

const instanceRow = (overrides: Partial<InstanceRow> = {}): InstanceRow => ({
	id: "abc123",
	organizationId: "org-1",
	hostId: "host-1",
	name: "afk-1",
	accountType: "microsoft",
	liveControlPort: 33333,
	liveControlTokenEncrypted: "sealed(32)",
	liveControlTokenKeyId: "k1",
	minecraftAccount: "afk@example.com",
	minecraftUsername: null,
	status: "running",
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
	username: "mcc",
	networkStack: null,
	architecture: null,
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
	minecraftAccount: "afk@example.com",
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
	inventoryDataEnabled: true,
	entityDataEnabled: true,
	advancedKeys: {},
	botConfig: {},
}

const configRow = (): InstanceConfigRow => ({
	id: "cfg-1",
	organizationId: "org-1",
	instanceId: "abc123",
	version: 1,
	document: SAVED_DOCUMENT,
	authorId: null,
	authorLabel: "owner@example.com",
	createdAt: new Date(),
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

const commandRow = (): InstanceCommandRow => ({
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
})

const auditEventRow = (entry: AuditEntry): AuditEventRow => ({
	id: "audit-1",
	organizationId: "org-1",
	subjectType: entry.subjectType,
	subjectId: entry.subjectId,
	action: entry.action,
	actorId: entry.actorId,
	actorLabel: entry.actorLabel,
	detail: entry.detail,
	createdAt: new Date(),
})

let client: Server
let clientPort = 0

beforeAll(async () => {
	client = createServer((request, response) => {
		const chunks: Buffer[] = []
		request.on("data", (chunk: Buffer) => chunks.push(chunk))
		request.on("end", () => {
			const message = JSON.parse(Buffer.concat(chunks).toString("utf8"))
			if (message.method === "initialize") {
				response.writeHead(200, { "content-type": "application/json" })
				response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }))
				return
			}
			if (message.method !== "tools/call") {
				response.writeHead(202).end()
				return
			}
			response.writeHead(200, { "content-type": "application/json" })
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					result: { structuredContent: { success: false, error: "disconnected" }, content: [] },
				}),
			)
		})
	})
	await new Promise<void>((resolve) => client.listen(0, "127.0.0.1", resolve))
	const address = client.address()
	clientPort = address !== null && typeof address === "object" ? address.port : 0
})

afterAll(async () => {
	await new Promise<void>((resolve) => client.close(() => resolve()))
})

const DEVICE_CODE_LOG =
	"To sign in, use a web browser to open the page https://www.microsoft.com/link and enter the code ABCD-EFGH to authenticate."

const build = () => {
	const writeTransport = createFakeTransport({
		[`cat ${instanceDir("abc123")}/auth.log 2>/dev/null || true`]: {
			stdout: DEVICE_CODE_LOG,
			stderr: "",
			exitCode: 0,
		},
	})
	const createTransport = vi.fn(() => writeTransport)
	const readFactory = vi.fn((): ReusableTransport => {
		const transport = createFakeTransport()
		return {
			...transport,
			forwardUntil: async () => {
				const socket = connect(clientPort, "127.0.0.1")
				return { socket, close: () => socket.destroy() }
			},
		}
	})
	const connections = createReadConnections({
		createTransport: readFactory,
		idleMs: READ_CONNECTION_IDLE_MS,
		hardAgeMs: READ_CONNECTION_HARD_AGE_MS,
		channelLimit: READ_CONNECTION_CHANNEL_LIMIT,
		now: () => Date.now(),
	})
	const lease = vi.fn(connections.lease)
	const audit: Pick<AuditRepository, "record"> = {
		record: vi.fn(async (_scope: OrgScope, entry: AuditEntry) => auditEventRow(entry)),
	}
	const instances: InstanceRepository = {
		findById: vi.fn(async (scope: OrgScope) =>
			scope.organizationId === "org-1" ? instanceRow() : undefined,
		),
		list: vi.fn(async () => [instanceRow()]),
		insert: vi.fn(async () => instanceRow()),
		update: vi.fn(async () => instanceRow()),
		delete: vi.fn(async () => true),
		claimForAuth: vi.fn(async () => instanceRow()),
		releaseAuthClaim: vi.fn(async () => true),
		insertConfigVersion: vi.fn(async () => configRow()),
		latestConfig: vi.fn(async () => configRow()),
	}
	const schedules: ScheduleRepository = {
		upsert: vi.fn(),
		findByInstance: vi.fn(async () => undefined),
		list: vi.fn(async () => []),
		delete: vi.fn(async () => true),
	}
	const commands: CommandRepository = {
		upsert: vi.fn(),
		listForInstance: vi.fn(async () => []),
		listEnabledAcrossOrganizations: vi.fn(async () => []),
		delete: vi.fn(async () => true),
		deleteReturning: vi.fn(async () => undefined),
		claimRun: vi.fn(async () => true),
		recordRun: vi.fn(async () => undefined),
	}
	const hostsFindById = vi.fn(async (scope: OrgScope, id: string) =>
		scope.organizationId === hostRow.organizationId && id === hostRow.id ? hostRow : undefined,
	)
	const controller = createInstanceController({
		instances,
		schedules,
		commands,
		hosts: { findById: hostsFindById },
		sshKeys: { findById: vi.fn(async () => sshKeyRow) },
		secrets: {
			open: () => "PRIVATE KEY",
			seal: (plaintext: string) => ({ ciphertext: `sealed(${plaintext.length})`, keyId: "k1" }),
			activeKeyId: "k1",
		},
		createTransport,
		readConnections: { lease },
		withTransaction: async (fn) => await fn({ instances, schedules, commands, audit }),
	})
	return { controller, createTransport, readFactory, lease, instances, connections }
}

describe("which calls share a host's connection", () => {
	it("C1: serves all ten live readouts and the console for one instance over one connection", async () => {
		const { controller, createTransport, readFactory, lease, connections } = build()

		const outcomes = await Promise.allSettled([
			controller.readLiveStatus(owner, "abc123"),
			controller.readLiveChat(owner, "abc123"),
			controller.readLiveEvents(owner, "abc123"),
			controller.readLiveWorld(owner, "abc123"),
			controller.readLiveEntities(owner, "abc123"),
			controller.readLiveInventory(owner, "abc123"),
			controller.readLivePlayerStats(owner, "abc123"),
			controller.readLiveStatusEffects(owner, "abc123"),
			controller.readLiveBots(owner, "abc123"),
			controller.readLivePlayers(owner, "abc123"),
			controller.readConsole(owner, "abc123", 50),
		])

		expect(outcomes).toHaveLength(11)
		expect(lease).toHaveBeenCalledTimes(11)
		expect(readFactory).toHaveBeenCalledTimes(1)
		expect(createTransport).not.toHaveBeenCalled()
		expect(connections.activeLeases()).toBe(0)
	})

	it("C2: opens a fresh connection for every write, sign-in and removal, and never takes a shared lease", async () => {
		const { controller, createTransport, readFactory, lease, instances } = build()
		const writes: Array<[string, () => Promise<void>]> = [
			["drop an item", () => controller.dropInventoryItem(owner, "abc123", "minecraft:dirt", 1)],
			["hold an item", () => controller.selectHeldItem(owner, "abc123", "minecraft:dirt")],
			["run a scheduled command", () => controller.runScheduledCommand(commandRow())],
			[
				"begin sign-in",
				async () => {
					await controller.authenticate(owner, "abc123")
				},
			],
			[
				"complete sign-in",
				async () => {
					vi.mocked(instances.findById).mockResolvedValueOnce(instanceRow({ status: "needs_auth" }))
					await controller.completeAuthentication(owner, "abc123")
				},
			],
			[
				"cancel sign-in",
				async () => {
					await controller.cancelAuthentication(owner, "abc123")
				},
			],
			["remove", () => controller.remove(owner, "abc123")],
			[
				"start",
				async () => {
					await controller.start(owner, "abc123")
				},
			],
		]

		for (const [write, run] of writes) {
			const before = createTransport.mock.calls.length
			await run().catch(() => undefined)
			expect(createTransport.mock.calls.length, write).toBeGreaterThan(before)
		}

		expect(lease).not.toHaveBeenCalled()
		expect(readFactory).not.toHaveBeenCalled()
	})

	it("C5: leases nothing for another organization naming this organization's instance or host", async () => {
		const { controller, readFactory, lease } = build()

		await expect(controller.hostMetrics(outsider, "host-1")).rejects.toBeInstanceOf(
			InstanceHostNotFoundError,
		)
		await expect(controller.readLiveStatus(outsider, "abc123")).rejects.toBeInstanceOf(
			InstanceNotFoundError,
		)
		await expect(controller.readConsole(outsider, "abc123", 50)).rejects.toBeInstanceOf(
			InstanceNotFoundError,
		)
		const reconciliation = await controller.reconcileHost(outsider, "host-1")

		expect(reconciliation).toEqual({ hostId: "host-1", reachable: false, reason: "misconfigured" })
		expect(readFactory).not.toHaveBeenCalled()
		expect(lease).not.toHaveBeenCalled()
	})
})

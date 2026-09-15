import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
import {
	type ConnectOptions,
	createFakeTransport,
	createReadConnections,
	type HostTransport,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
} from "@open-mcc/transport"
import { sql } from "kysely"
import { afterAll, describe, expect, it, vi } from "vitest"
import { createAuditRepository } from "../audit/audit.repository"
import { createSshKeyRepository } from "../ssh-key/ssh-key.repository"
import {
	seedMember,
	seedOrganization,
	teardownTestDb,
	testDb,
	trackHostId,
	trackSshKeyId,
} from "../test/db"
import {
	type ActorContext,
	createHostController,
	createHostControllerTransaction,
	HostConcurrentlyModifiedError,
	type HostControllerDeps,
	HostMisconfiguredError,
	HostProvisioningInProgressError,
	type WithTransaction,
} from "./host.controller"
import {
	createHostRepository,
	type HostRepository,
	type OrgScope,
	PROVISIONING_LEASE_MS,
} from "./host.repository"
import { hostReadKey, leaseHostReader } from "./host-reader"
import { provisionableHost } from "./provisionable-host"

const jobsDouble = () => ({ enqueue: vi.fn(async () => undefined) })

const sendJobDouble = async () => null

const PROVISIONABLE = provisionableHost()

const encodeAlgorithmBlob = (algorithm: string, extra: Buffer = Buffer.alloc(0)): Buffer => {
	const name = Buffer.from(algorithm, "ascii")
	const length = Buffer.alloc(4)
	length.writeUInt32BE(name.length, 0)
	return Buffer.concat([length, name, extra])
}

const HOST_KEY_BLOB = encodeAlgorithmBlob("ssh-ed25519", Buffer.from("tx-test-key-material"))
const EXPECTED_FINGERPRINT = fingerprintFromKey(HOST_KEY_BLOB)
const ROTATED_HOST_KEY_BLOB = encodeAlgorithmBlob(
	"ssh-ed25519",
	Buffer.from("tx-rotated-key-material"),
)
const ROTATED_FINGERPRINT = fingerprintFromKey(ROTATED_HOST_KEY_BLOB)

const backdateProvisioningClaim = async (hostId: string, ageMs: number): Promise<void> => {
	await testDb()
		.updateTable("host")
		.set({ provisioningClaimedAt: new Date(Date.now() - ageMs) })
		.where("id", "=", hostId)
		.execute()
}

const throwingAudit = {
	record: vi.fn(async () => Promise.reject(new Error("audit insert failed"))),
}

const baseDeps = (): Omit<HostControllerDeps, "withTransaction" | "hosts"> => ({
	sshKeys: { findById: vi.fn(async () => undefined) },
	secrets: { activeKeyId: "k1", seal: vi.fn(), open: vi.fn() },
	probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
	createTransport: vi.fn(),
	evictHost: () => undefined,
	instanceIdsOnHost: vi.fn(async () => []),
	now: () => new Date(),
})

describe("host controller transactional mutations", () => {
	afterAll(async () => {
		await teardownTestDb()
	})

	it("rolls back the host insert when the audit insert throws during enrollment", async () => {
		const organizationId = await seedOrganization("org-tx-enroll")
		const memberId = await seedMember(organizationId)
		const db = testDb()
		const hosts = createHostRepository(db)
		const sshKeyRow = await createSshKeyRepository(db).insert(
			{ organizationId },
			{
				name: "tx-key",
				publicKey: "ssh-ed25519 AAAA...",
				privateKeyEncrypted: "sealed",
				privateKeyKeyId: "k1",
			},
		)
		trackSshKeyId(sshKeyRow.id)

		const controller = createHostController({
			...baseDeps(),
			hosts,
			withTransaction: (fn) =>
				db
					.transaction()
					.execute((tx) =>
						fn({ hosts: createHostRepository(tx), audit: throwingAudit, jobs: jobsDouble() }),
					),
		})

		await expect(
			controller.enroll(
				{ organizationId, memberId, actorLabel: "actor@example.com", role: "owner" },
				{
					name: "vps-tx",
					hostname: "10.0.0.50",
					port: 22,
					username: "mcc",
					sshKeyId: sshKeyRow.id,
					expectedFingerprint: EXPECTED_FINGERPRINT,
				},
			),
		).rejects.toThrow(/audit insert failed/)

		const remaining = await hosts.list({ organizationId })
		expect(remaining).toEqual([])
	})

	it("rolls back the host delete when the audit insert throws during removal", async () => {
		const organizationId = await seedOrganization("org-tx-remove")
		const db = testDb()
		const hosts = createHostRepository(db)
		const created = await hosts.insert(
			{ organizationId },
			{ name: "vps-tx-remove", hostname: "10.0.0.51", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)

		const controller = createHostController({
			...baseDeps(),
			hosts,
			withTransaction: (fn) =>
				db
					.transaction()
					.execute((tx) =>
						fn({ hosts: createHostRepository(tx), audit: throwingAudit, jobs: jobsDouble() }),
					),
		})

		await expect(
			controller.remove(
				{ organizationId, memberId: "mem-x", actorLabel: "actor@example.com", role: "owner" },
				created.id,
			),
		).rejects.toThrow(/audit insert failed/)

		const stillThere = await hosts.findById({ organizationId }, created.id)
		expect(stillThere?.id).toBe(created.id)
	})

	it("rejects enrollment when the actor has a memberId but an empty label, leaving no residue", async () => {
		const organizationId = await seedOrganization("org-tx-empty-label")
		const memberId = await seedMember(organizationId)
		const db = testDb()
		const hosts = createHostRepository(db)
		const sshKeyRow = await createSshKeyRepository(db).insert(
			{ organizationId },
			{
				name: "tx-key-2",
				publicKey: "ssh-ed25519 AAAA...",
				privateKeyEncrypted: "sealed",
				privateKeyKeyId: "k1",
			},
		)
		trackSshKeyId(sshKeyRow.id)

		const controller = createHostController({
			...baseDeps(),
			hosts,
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		await expect(
			controller.enroll(
				{ organizationId, memberId, actorLabel: "", role: "owner" },
				{
					name: "vps-tx-2",
					hostname: "10.0.0.52",
					port: 22,
					username: "mcc",
					sshKeyId: sshKeyRow.id,
					expectedFingerprint: EXPECTED_FINGERPRINT,
				},
			),
		).rejects.toThrow(/label is required/i)

		const remaining = await hosts.list({ organizationId })
		expect(remaining).toEqual([])
	})
})

describe("host controller provisioning lock serialisation (real Postgres)", () => {
	afterAll(async () => {
		await teardownTestDb()
	})

	const seedProvisionableHost = async (slugPrefix: string) => {
		const organizationId = await seedOrganization(slugPrefix)
		const memberId = await seedMember(organizationId)
		const db = testDb()
		const hosts = createHostRepository(db)
		const sshKeys = createSshKeyRepository(db)
		const sshKeyRow = await sshKeys.insert(
			{ organizationId },
			{
				name: `${slugPrefix}-key`,
				publicKey: "ssh-ed25519 AAAA...",
				privateKeyEncrypted: "sealed",
				privateKeyKeyId: "k1",
			},
		)
		trackSshKeyId(sshKeyRow.id)
		const created = await hosts.insert(
			{ organizationId },
			{
				name: `${slugPrefix}-host`,
				hostname: "10.0.0.90",
				port: 22,
				username: "mcc",
				osRelease: "systemd 252",
				osId: "debian",
				osName: "Debian GNU/Linux 12 (bookworm)",
				failedUnits: null,
				teardownError: null,
				teardownRequestedAt: null,
				sshKeyId: sshKeyRow.id,
				hostKeyAlgorithm: "ssh-ed25519",
				hostKeyFingerprint: EXPECTED_FINGERPRINT,
				hostKeyTrustedBy: memberId,
				hostKeyTrustedByLabel: "actor@example.com",
				hostKeyTrustedAt: new Date(),
				status: "pending",
			},
		)
		trackHostId(created.id)
		return { organizationId, memberId, db, hosts, sshKeys, hostId: created.id }
	}

	const actorFor = (organizationId: string, memberId: string): ActorContext => ({
		organizationId,
		memberId,
		actorLabel: "actor@example.com",
		role: "owner",
	})

	it("lets exactly one of two concurrent provision calls that both passed the status read succeed", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-lock-race")

		let readsStarted = 0
		let releaseReads: () => void = () => {}
		const bothStatusReadsDone = new Promise<void>((resolve) => {
			releaseReads = resolve
		})
		const barrieredSshKeys = {
			findById: async (scope: OrgScope, id: string) => {
				readsStarted += 1
				if (readsStarted === 2) releaseReads()
				await bothStatusReadsDone
				return sshKeys.findById(scope, id)
			},
		}

		const controller = createHostController({
			hosts,
			sshKeys: barrieredSshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(() =>
				createFakeTransport({
					...PROVISIONABLE,
					"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
				}),
			),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		const results = await Promise.allSettled([
			controller.provision(ctx, hostId),
			controller.provision(ctx, hostId),
		])

		const fulfilled = results.filter((result) => result.status === "fulfilled")
		const rejected = results.filter((result) => result.status === "rejected")
		expect(fulfilled).toHaveLength(1)
		expect(rejected).toHaveLength(1)
		const firstRejected = rejected[0]
		if (firstRejected?.status !== "rejected") {
			throw new Error("expected exactly one rejected provision call")
		}
		expect(firstRejected.reason).toBeInstanceOf(HostConcurrentlyModifiedError)

		const final = await hosts.findById({ organizationId }, hostId)
		expect(final?.status).toBe("ready")
		expect(final?.networkStack).toBe("slirp4netns")
	})

	it("does not re-claim a host that is already provisioning", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-lock-stuck")
		await hosts.claimForProvisioning({ organizationId }, hostId, "pending")

		const createTransport = vi.fn(() =>
			createFakeTransport({
				...PROVISIONABLE,
				"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
			}),
		)
		const open = vi.fn(() => "PRIVATE KEY")
		const controller = createHostController({
			hosts,
			sshKeys,
			secrets: { open, activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport,
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		await expect(controller.provision(ctx, hostId)).rejects.toThrow(HostProvisioningInProgressError)

		expect(open).not.toHaveBeenCalled()
		expect(createTransport).not.toHaveBeenCalled()
		const stillProvisioning = await hosts.findById({ organizationId }, hostId)
		expect(stillProvisioning?.status).toBe("provisioning")
	})
})

describe("host controller refuses to delete a provisioning host (real Postgres)", () => {
	afterAll(async () => {
		await teardownTestDb()
	})

	const seedProvisionableHost = async (slugPrefix: string) => {
		const organizationId = await seedOrganization(slugPrefix)
		const memberId = await seedMember(organizationId)
		const db = testDb()
		const hosts = createHostRepository(db)
		const sshKeys = createSshKeyRepository(db)
		const sshKeyRow = await sshKeys.insert(
			{ organizationId },
			{
				name: `${slugPrefix}-key`,
				publicKey: "ssh-ed25519 AAAA...",
				privateKeyEncrypted: "sealed",
				privateKeyKeyId: "k1",
			},
		)
		trackSshKeyId(sshKeyRow.id)
		const created = await hosts.insert(
			{ organizationId },
			{
				name: `${slugPrefix}-host`,
				hostname: "10.0.0.91",
				port: 22,
				username: "mcc",
				osRelease: "systemd 252",
				osId: "debian",
				osName: "Debian GNU/Linux 12 (bookworm)",
				failedUnits: null,
				teardownError: null,
				teardownRequestedAt: null,
				sshKeyId: sshKeyRow.id,
				hostKeyAlgorithm: "ssh-ed25519",
				hostKeyFingerprint: EXPECTED_FINGERPRINT,
				hostKeyTrustedBy: memberId,
				hostKeyTrustedByLabel: "actor@example.com",
				hostKeyTrustedAt: new Date(),
				status: "pending",
			},
		)
		trackHostId(created.id)
		return { organizationId, memberId, db, hosts, sshKeys, hostId: created.id }
	}

	const actorFor = (organizationId: string, memberId: string): ActorContext => ({
		organizationId,
		memberId,
		actorLabel: "actor@example.com",
		role: "owner",
	})

	it("rejects deleting a host whose status is provisioning, leaving the row in place", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-refuse-delete")
		await hosts.claimForProvisioning({ organizationId }, hostId, "pending")

		const controller = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		await expect(controller.remove(ctx, hostId)).rejects.toThrow(HostProvisioningInProgressError)

		const stillThere = await hosts.findById({ organizationId }, hostId)
		expect(stillThere?.status).toBe("provisioning")
	})

	it("marks a provisioned host for teardown rather than deleting it outright", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-allow-delete")

		const controller = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		await expect(controller.remove(ctx, hostId)).resolves.toBe(true)

		const stillThere = await hosts.findById({ organizationId }, hostId)
		expect(stillThere?.status).toBe("removing")
		expect(stillThere?.teardownRequestedAt).not.toBeNull()
	})

	it("rejects a delete attempted during the remote-work window, then completes provisioning normally", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-refuse-mid-flight")

		let releaseGate: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve
		})
		let signalConnectStarted: () => void = () => {}
		const connectStarted = new Promise<void>((resolve) => {
			signalConnectStarted = resolve
		})

		const gatedTransport = (): HostTransport => {
			const inner = createFakeTransport({
				...PROVISIONABLE,
				"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
			})
			return {
				state: inner.state,
				canForward: inner.canForward,
				forward: () => Promise.reject(new Error("not forwarded in this test")),
				connect: async (options) => {
					signalConnectStarted()
					await gate
					await inner.connect(options)
				},
				exec: inner.exec,
				close: inner.close,
			}
		}

		const controller = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(gatedTransport),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		const provisionPromise = controller.provision(ctx, hostId)
		try {
			await connectStarted
			await expect(controller.remove(ctx, hostId)).rejects.toThrow(HostProvisioningInProgressError)
		} finally {
			releaseGate()
			await provisionPromise.catch(() => {})
		}

		const provisionResult = await provisionPromise
		expect(provisionResult?.status).toBe("ready")
		expect(await hosts.findById({ organizationId }, hostId)).toMatchObject({ status: "ready" })
	})

	it("succeeds once provisioning has completed and status is no longer provisioning", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-refuse-then-allow")

		const controller = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(() =>
				createFakeTransport({
					...PROVISIONABLE,
					"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
				}),
			),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		await controller.provision(ctx, hostId)
		expect((await hosts.findById({ organizationId }, hostId))?.status).toBe("ready")

		await expect(controller.remove(ctx, hostId)).resolves.toBe(true)
		const marked = await hosts.findById({ organizationId }, hostId)
		expect(marked?.status).toBe("removing")
	})

	it("deletes a host whose provisioning claim has expired past the lease", async () => {
		const { organizationId, memberId, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-expired-delete")
		await hosts.claimForProvisioning({ organizationId }, hostId, "pending")
		await backdateProvisioningClaim(hostId, PROVISIONING_LEASE_MS + 1_000)

		const controller = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(testDb(), sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		await expect(controller.remove(ctx, hostId)).resolves.toBe(true)
		const marked = await hosts.findById({ organizationId }, hostId)
		expect(marked?.status).toBe("removing")
	})

	it("still refuses to delete a host whose provisioning claim is still within its lease", async () => {
		const { organizationId, memberId, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-live-claim-delete")
		await hosts.claimForProvisioning({ organizationId }, hostId, "pending")

		const controller = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(testDb(), sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		await expect(controller.remove(ctx, hostId)).rejects.toThrow(HostProvisioningInProgressError)
		expect((await hosts.findById({ organizationId }, hostId))?.status).toBe("provisioning")
	})
})

describe("host controller keeps no transaction open across remote provisioning work (real Postgres)", () => {
	afterAll(async () => {
		await teardownTestDb()
	})

	const seedProvisionableHost = async (slugPrefix: string) => {
		const organizationId = await seedOrganization(slugPrefix)
		const memberId = await seedMember(organizationId)
		const db = testDb()
		const hosts = createHostRepository(db)
		const sshKeys = createSshKeyRepository(db)
		const sshKeyRow = await sshKeys.insert(
			{ organizationId },
			{
				name: `${slugPrefix}-key`,
				publicKey: "ssh-ed25519 AAAA...",
				privateKeyEncrypted: "sealed",
				privateKeyKeyId: "k1",
			},
		)
		trackSshKeyId(sshKeyRow.id)
		const created = await hosts.insert(
			{ organizationId },
			{
				name: `${slugPrefix}-host`,
				hostname: "10.0.0.92",
				port: 22,
				username: "mcc",
				osRelease: "systemd 252",
				osId: "debian",
				osName: "Debian GNU/Linux 12 (bookworm)",
				failedUnits: null,
				teardownError: null,
				teardownRequestedAt: null,
				sshKeyId: sshKeyRow.id,
				hostKeyAlgorithm: "ssh-ed25519",
				hostKeyFingerprint: EXPECTED_FINGERPRINT,
				hostKeyTrustedBy: memberId,
				hostKeyTrustedByLabel: "actor@example.com",
				hostKeyTrustedAt: new Date(),
				status: "pending",
			},
		)
		trackHostId(created.id)
		return { organizationId, memberId, db, hosts, sshKeys, hostId: created.id }
	}

	const actorFor = (organizationId: string, memberId: string): ActorContext => ({
		organizationId,
		memberId,
		actorLabel: "actor@example.com",
		role: "owner",
	})

	const instrumentWithTransaction = (
		inner: WithTransaction,
	): { withTransaction: WithTransaction; isInsideTransaction: () => boolean } => {
		let openCount = 0
		const withTransaction: WithTransaction = async (fn) => {
			openCount += 1
			try {
				return await inner(fn)
			} finally {
				openCount -= 1
			}
		}
		return { withTransaction, isInsideTransaction: () => openCount > 0 }
	}

	it("never has a transaction open while the transport is doing remote work", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-no-open-txn")

		const { withTransaction, isInsideTransaction } = instrumentWithTransaction(
			createHostControllerTransaction(db, sendJobDouble),
		)

		const sightings: boolean[] = []
		const instrumentedTransport = (): HostTransport => {
			const inner = createFakeTransport({
				...PROVISIONABLE,
				"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
			})
			return {
				state: inner.state,
				canForward: inner.canForward,
				forward: () => Promise.reject(new Error("not forwarded in this test")),
				connect: async (options) => {
					sightings.push(isInsideTransaction())
					await inner.connect(options)
				},
				exec: async (command, timeoutMs) => {
					sightings.push(isInsideTransaction())
					return inner.exec(command, timeoutMs)
				},
				close: inner.close,
			}
		}

		const controller = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(instrumentedTransport),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction,
		})

		const ctx = actorFor(organizationId, memberId)
		await controller.provision(ctx, hostId)

		expect(sightings.length).toBeGreaterThan(0)
		expect(sightings.every((insideTransaction) => insideTransaction === false)).toBe(true)
	})

	it("completes successfully even when the remote work outlasts a short idle-in-transaction timeout", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-no-idle-txn")

		const withShortIdleTimeout: WithTransaction = (fn) =>
			db.transaction().execute(async (tx) => {
				await sql`set local idle_in_transaction_session_timeout = '200ms'`.execute(tx)
				return fn({
					hosts: createHostRepository(tx),
					audit: createAuditRepository(tx),
					jobs: jobsDouble(),
				})
			})

		const slowTransport = (): HostTransport => {
			const inner = createFakeTransport({
				...PROVISIONABLE,
				"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
			})
			return {
				state: inner.state,
				canForward: inner.canForward,
				forward: () => Promise.reject(new Error("not forwarded in this test")),
				connect: async (options) => {
					await new Promise((resolve) => setTimeout(resolve, 400))
					await inner.connect(options)
				},
				exec: inner.exec,
				close: inner.close,
			}
		}

		const controller = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(slowTransport),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: withShortIdleTimeout,
		})

		const ctx = actorFor(organizationId, memberId)
		const result = await controller.provision(ctx, hostId)

		expect(result?.status).toBe("ready")
		expect(await hosts.findById({ organizationId }, hostId)).toMatchObject({ status: "ready" })
	})
})

describe("host controller provisioning lease reclaim (real Postgres)", () => {
	afterAll(async () => {
		await teardownTestDb()
	})

	const seedProvisionableHost = async (slugPrefix: string) => {
		const organizationId = await seedOrganization(slugPrefix)
		const memberId = await seedMember(organizationId)
		const db = testDb()
		const hosts = createHostRepository(db)
		const sshKeys = createSshKeyRepository(db)
		const sshKeyRow = await sshKeys.insert(
			{ organizationId },
			{
				name: `${slugPrefix}-key`,
				publicKey: "ssh-ed25519 AAAA...",
				privateKeyEncrypted: "sealed",
				privateKeyKeyId: "k1",
			},
		)
		trackSshKeyId(sshKeyRow.id)
		const created = await hosts.insert(
			{ organizationId },
			{
				name: `${slugPrefix}-host`,
				hostname: "10.0.0.93",
				port: 22,
				username: "mcc",
				osRelease: "systemd 252",
				osId: "debian",
				osName: "Debian GNU/Linux 12 (bookworm)",
				failedUnits: null,
				teardownError: null,
				teardownRequestedAt: null,
				sshKeyId: sshKeyRow.id,
				hostKeyAlgorithm: "ssh-ed25519",
				hostKeyFingerprint: EXPECTED_FINGERPRINT,
				hostKeyTrustedBy: memberId,
				hostKeyTrustedByLabel: "actor@example.com",
				hostKeyTrustedAt: new Date(),
				status: "pending",
			},
		)
		trackHostId(created.id)
		return { organizationId, memberId, db, hosts, sshKeys, hostId: created.id }
	}

	const actorFor = (organizationId: string, memberId: string): ActorContext => ({
		organizationId,
		memberId,
		actorLabel: "actor@example.com",
		role: "owner",
	})

	it("reclaims an abandoned provisioning claim once its lease has expired, auditing the reclaim", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-reclaim-audit")
		const abandonedClaim = await hosts.claimForProvisioning({ organizationId }, hostId, "pending")
		const abandonedAttemptId = abandonedClaim?.provisioningAttemptId
		if (!abandonedAttemptId) throw new Error("expected a claimed attempt id")
		await backdateProvisioningClaim(hostId, PROVISIONING_LEASE_MS + 1_000)

		const controller = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(() =>
				createFakeTransport({
					...PROVISIONABLE,
					"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
				}),
			),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		const result = await controller.provision(ctx, hostId)

		expect(result?.status).toBe("ready")
		expect((await hosts.findById({ organizationId }, hostId))?.provisioningAttemptId).toBeNull()

		const auditEvents = await createAuditRepository(db).list({ organizationId })
		const reclaimEvent = auditEvents.find((event) => event.action === "host.provision.reclaim")
		expect(reclaimEvent).toBeDefined()
		expect(reclaimEvent?.detail).toMatchObject({ previousAttemptId: abandonedAttemptId })
	})

	it("does not reclaim, or audit a reclaim of, a provisioning claim that is still within its lease", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-no-reclaim-audit")
		await hosts.claimForProvisioning({ organizationId }, hostId, "pending")

		const controller = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		await expect(controller.provision(ctx, hostId)).rejects.toThrow(HostProvisioningInProgressError)

		const auditEvents = await createAuditRepository(db).list({ organizationId })
		expect(auditEvents.find((event) => event.action === "host.provision.reclaim")).toBeUndefined()
	})
})

describe("host controller serialises re-trust against provisioning (real Postgres)", () => {
	afterAll(async () => {
		await teardownTestDb()
	})

	const seedProvisionableHost = async (slugPrefix: string) => {
		const organizationId = await seedOrganization(slugPrefix)
		const memberId = await seedMember(organizationId)
		const db = testDb()
		const hosts = createHostRepository(db)
		const sshKeys = createSshKeyRepository(db)
		const sshKeyRow = await sshKeys.insert(
			{ organizationId },
			{
				name: `${slugPrefix}-key`,
				publicKey: "ssh-ed25519 AAAA...",
				privateKeyEncrypted: "sealed",
				privateKeyKeyId: "k1",
			},
		)
		trackSshKeyId(sshKeyRow.id)
		const created = await hosts.insert(
			{ organizationId },
			{
				name: `${slugPrefix}-host`,
				hostname: "10.0.0.94",
				port: 22,
				username: "mcc",
				osRelease: "systemd 252",
				osId: "debian",
				osName: "Debian GNU/Linux 12 (bookworm)",
				failedUnits: null,
				teardownError: null,
				teardownRequestedAt: null,
				sshKeyId: sshKeyRow.id,
				hostKeyAlgorithm: "ssh-ed25519",
				hostKeyFingerprint: EXPECTED_FINGERPRINT,
				hostKeyTrustedBy: memberId,
				hostKeyTrustedByLabel: "actor@example.com",
				hostKeyTrustedAt: new Date(),
				status: "pending",
			},
		)
		trackHostId(created.id)
		return { organizationId, memberId, db, hosts, sshKeys, hostId: created.id }
	}

	const actorFor = (organizationId: string, memberId: string): ActorContext => ({
		organizationId,
		memberId,
		actorLabel: "actor@example.com",
		role: "owner",
	})

	it("blocks a concurrent re-trust until the provisioning claim's lock is released, then rejects it because the claim is now live", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-retrust-serialise")

		let releaseLockHold: () => void = () => {}
		const lockHoldGate = new Promise<void>((resolve) => {
			releaseLockHold = resolve
		})
		let signalLockAcquired: () => void = () => {}
		const lockAcquired = new Promise<void>((resolve) => {
			signalLockAcquired = resolve
		})

		const gatedWithTransaction: WithTransaction = (fn) =>
			db.transaction().execute(async (tx) => {
				const realHosts = createHostRepository(tx)
				const gatedHosts: HostRepository = {
					...realHosts,
					lockHost: async (scope: OrgScope, id: string) => {
						await realHosts.lockHost(scope, id)
						signalLockAcquired()
						await lockHoldGate
					},
				}
				return fn({ hosts: gatedHosts, audit: createAuditRepository(tx), jobs: jobsDouble() })
			})

		const provisionController = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(() =>
				createFakeTransport({
					...PROVISIONABLE,
					"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
				}),
			),
			withTransaction: gatedWithTransaction,
		})
		const retrustController = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => ROTATED_HOST_KEY_BLOB),
			createTransport: vi.fn(),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		const provisionPromise = provisionController.provision(ctx, hostId)
		await lockAcquired

		let retrustSettled = false
		const retrustPromise = retrustController
			.retrustHostKey(ctx, hostId, {
				hostKeyFingerprint: ROTATED_FINGERPRINT,
			})
			.finally(() => {
				retrustSettled = true
			})

		try {
			await new Promise((resolve) => setTimeout(resolve, 150))
			expect(retrustSettled).toBe(false)
		} finally {
			releaseLockHold()
			const provisionSettled = provisionPromise.catch(() => {})
			const retrustQuietlySettled = retrustPromise.catch(() => {})
			await provisionSettled
			await retrustQuietlySettled
		}

		await provisionPromise
		await expect(retrustPromise).rejects.toThrow(HostProvisioningInProgressError)

		expect(retrustSettled).toBe(true)
		const finalHost = await hosts.findById({ organizationId }, hostId)
		expect(finalHost?.hostKeyFingerprint).toBe(EXPECTED_FINGERPRINT)
	})

	it("uses the host key fingerprint as of the provisioning lock, not a value cached before it", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-retrust-fresh-read")

		let releaseSshKeyLookup: () => void = () => {}
		const sshKeyLookupGate = new Promise<void>((resolve) => {
			releaseSshKeyLookup = resolve
		})
		let signalSshKeyLookupStarted: () => void = () => {}
		const sshKeyLookupStarted = new Promise<void>((resolve) => {
			signalSshKeyLookupStarted = resolve
		})

		const gatedSshKeys = {
			findById: async (scope: { organizationId: string }, id: string) => {
				signalSshKeyLookupStarted()
				await sshKeyLookupGate
				return sshKeys.findById(scope, id)
			},
		}

		let observedFingerprint: string | undefined
		const recordingTransport = (): HostTransport => {
			const inner = createFakeTransport({
				...PROVISIONABLE,
				"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
			})
			return {
				state: inner.state,
				canForward: inner.canForward,
				forward: () => Promise.reject(new Error("not forwarded in this test")),
				connect: async (options) => {
					observedFingerprint = options.expectedFingerprint
					await inner.connect(options)
				},
				exec: inner.exec,
				close: inner.close,
			}
		}
		const provisionController = createHostController({
			hosts,
			sshKeys: gatedSshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(recordingTransport),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})
		const retrustController = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => ROTATED_HOST_KEY_BLOB),
			createTransport: vi.fn(),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		const provisionPromise = provisionController.provision(ctx, hostId)
		try {
			await sshKeyLookupStarted
			await retrustController.retrustHostKey(ctx, hostId, {
				hostKeyFingerprint: ROTATED_FINGERPRINT,
			})
		} finally {
			releaseSshKeyLookup()
			await provisionPromise.catch(() => {})
		}

		await provisionPromise

		expect(observedFingerprint).toBe(ROTATED_FINGERPRINT)
	})

	it("connects to the address as of the provisioning lock, not to one cached before it", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-address-fresh-read")

		let releaseSshKeyLookup: () => void = () => {}
		const sshKeyLookupGate = new Promise<void>((resolve) => {
			releaseSshKeyLookup = resolve
		})
		let signalSshKeyLookupStarted: () => void = () => {}
		const sshKeyLookupStarted = new Promise<void>((resolve) => {
			signalSshKeyLookupStarted = resolve
		})

		const gatedSshKeys = {
			findById: async (scope: OrgScope, id: string) => {
				signalSshKeyLookupStarted()
				await sshKeyLookupGate
				return sshKeys.findById(scope, id)
			},
		}

		let observedTarget: { hostname: string; port: number; username: string } | undefined
		const recordingTransport = (): HostTransport => {
			const inner = createFakeTransport({
				...PROVISIONABLE,
				"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
			})
			return {
				state: inner.state,
				canForward: inner.canForward,
				forward: () => Promise.reject(new Error("not forwarded in this test")),
				connect: async (options) => {
					observedTarget = {
						hostname: options.hostname,
						port: options.port,
						username: options.username,
					}
					await inner.connect(options)
				},
				exec: inner.exec,
				close: inner.close,
			}
		}

		const controller = createHostController({
			hosts,
			sshKeys: gatedSshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(recordingTransport),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const relocated = { hostname: "10.0.0.91", port: 2222, username: "relocated" }
		const ctx = actorFor(organizationId, memberId)
		const provisionPromise = controller.provision(ctx, hostId)
		try {
			await sshKeyLookupStarted
			await hosts.update({ organizationId }, hostId, relocated)
		} finally {
			releaseSshKeyLookup()
			await provisionPromise.catch(() => {})
		}

		await provisionPromise

		expect(observedTarget).toEqual(relocated)
	})

	it("leaves the status and lease untouched when the ssh key changed before the claim", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-key-superseded")

		const rotatedKey = await sshKeys.insert(
			{ organizationId },
			{
				name: "org-key-superseded-rotated",
				publicKey: "ssh-ed25519 AAAA...",
				privateKeyEncrypted: "sealed-rotated",
				privateKeyKeyId: "k1",
			},
		)
		trackSshKeyId(rotatedKey.id)

		let releaseSshKeyLookup: () => void = () => {}
		const sshKeyLookupGate = new Promise<void>((resolve) => {
			releaseSshKeyLookup = resolve
		})
		let signalSshKeyLookupStarted: () => void = () => {}
		const sshKeyLookupStarted = new Promise<void>((resolve) => {
			signalSshKeyLookupStarted = resolve
		})

		const gatedSshKeys = {
			findById: async (scope: OrgScope, id: string) => {
				signalSshKeyLookupStarted()
				await sshKeyLookupGate
				return sshKeys.findById(scope, id)
			},
		}

		const open = vi.fn((encrypted: string) => `private-key-of:${encrypted}`)
		const createTransport = vi.fn(() =>
			createFakeTransport({
				...PROVISIONABLE,
				"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
			}),
		)
		const controller = createHostController({
			hosts,
			sshKeys: gatedSshKeys,
			secrets: { open, activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport,
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		const provisionPromise = controller.provision(ctx, hostId)
		try {
			await sshKeyLookupStarted
			await hosts.update({ organizationId }, hostId, { sshKeyId: rotatedKey.id })
		} finally {
			releaseSshKeyLookup()
			await provisionPromise.catch(() => {})
		}

		await expect(provisionPromise).rejects.toThrow(HostConcurrentlyModifiedError)
		expect(open).not.toHaveBeenCalled()
		expect(createTransport).not.toHaveBeenCalled()

		const finalHost = await hosts.findById({ organizationId }, hostId)
		expect(finalHost?.sshKeyId).toBe(rotatedKey.id)
		expect(finalHost?.status).toBe("pending")
		expect(finalHost?.provisioningAttemptId).toBeNull()
		expect(finalHost?.provisioningClaimedAt).toBeNull()
	})

	it("leaves the status and lease untouched when the host key fingerprint went missing before the claim", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-fingerprint-cleared")

		let releaseSshKeyLookup: () => void = () => {}
		const sshKeyLookupGate = new Promise<void>((resolve) => {
			releaseSshKeyLookup = resolve
		})
		let signalSshKeyLookupStarted: () => void = () => {}
		const sshKeyLookupStarted = new Promise<void>((resolve) => {
			signalSshKeyLookupStarted = resolve
		})
		const gatedSshKeys = {
			findById: async (scope: OrgScope, id: string) => {
				signalSshKeyLookupStarted()
				await sshKeyLookupGate
				return sshKeys.findById(scope, id)
			},
		}

		const open = vi.fn(() => "PRIVATE KEY")
		const createTransport = vi.fn()
		const controller = createHostController({
			hosts,
			sshKeys: gatedSshKeys,
			secrets: { open, activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport,
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		const provisionPromise = controller.provision(ctx, hostId)
		try {
			await sshKeyLookupStarted
			await testDb()
				.updateTable("host")
				.set({
					hostKeyFingerprint: null,
					hostKeyAlgorithm: null,
					hostKeyTrustedAt: null,
					hostKeyTrustedBy: null,
				})
				.where("id", "=", hostId)
				.execute()
		} finally {
			releaseSshKeyLookup()
			await provisionPromise.catch(() => {})
		}

		await expect(provisionPromise).rejects.toThrow(HostMisconfiguredError)
		expect(open).not.toHaveBeenCalled()
		expect(createTransport).not.toHaveBeenCalled()

		const finalHost = await hosts.findById({ organizationId }, hostId)
		expect(finalHost?.status).toBe("pending")
		expect(finalHost?.provisioningAttemptId).toBeNull()
		expect(finalHost?.provisioningClaimedAt).toBeNull()
	})

	it("audits the reclaim it decided under the lock, not the one it read before it", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-reclaim-under-lock")

		let releaseSshKeyLookup: () => void = () => {}
		const sshKeyLookupGate = new Promise<void>((resolve) => {
			releaseSshKeyLookup = resolve
		})
		let signalSshKeyLookupStarted: () => void = () => {}
		const sshKeyLookupStarted = new Promise<void>((resolve) => {
			signalSshKeyLookupStarted = resolve
		})
		const gatedSshKeys = {
			findById: async (scope: OrgScope, id: string) => {
				signalSshKeyLookupStarted()
				await sshKeyLookupGate
				return sshKeys.findById(scope, id)
			},
		}

		const controller = createHostController({
			hosts,
			sshKeys: gatedSshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(() =>
				createFakeTransport({
					...PROVISIONABLE,
					"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
				}),
			),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		let abandonedAttemptId: string | undefined
		const provisionPromise = controller.provision(ctx, hostId)
		try {
			await sshKeyLookupStarted
			const abandoned = await hosts.claimForProvisioning({ organizationId }, hostId, "pending")
			abandonedAttemptId = abandoned?.provisioningAttemptId ?? undefined
			await backdateProvisioningClaim(hostId, PROVISIONING_LEASE_MS * 2)
		} finally {
			releaseSshKeyLookup()
			await provisionPromise.catch(() => {})
		}

		await provisionPromise

		const auditEvents = await createAuditRepository(db).list({ organizationId })
		const reclaim = auditEvents.find((event) => event.action === "host.provision.reclaim")
		expect(reclaim?.subjectId).toBe(hostId)
		expect(abandonedAttemptId).toBeDefined()
		expect(reclaim?.detail).toMatchObject({ previousAttemptId: abandonedAttemptId })

		const finalHost = await hosts.findById({ organizationId }, hostId)
		expect(finalHost?.status).toBe("ready")
	})

	it("uses the status read before the lock to claim, so a status that moved since is still detected", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-status-moved")

		let releaseSshKeyLookup: () => void = () => {}
		const sshKeyLookupGate = new Promise<void>((resolve) => {
			releaseSshKeyLookup = resolve
		})
		let signalSshKeyLookupStarted: () => void = () => {}
		const sshKeyLookupStarted = new Promise<void>((resolve) => {
			signalSshKeyLookupStarted = resolve
		})
		const gatedSshKeys = {
			findById: async (scope: OrgScope, id: string) => {
				signalSshKeyLookupStarted()
				await sshKeyLookupGate
				return sshKeys.findById(scope, id)
			},
		}

		const open = vi.fn(() => "PRIVATE KEY")
		const createTransport = vi.fn()
		const controller = createHostController({
			hosts,
			sshKeys: gatedSshKeys,
			secrets: { open, activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport,
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		const provisionPromise = controller.provision(ctx, hostId)
		try {
			await sshKeyLookupStarted
			await hosts.update({ organizationId }, hostId, { status: "error" })
		} finally {
			releaseSshKeyLookup()
			await provisionPromise.catch(() => {})
		}

		await expect(provisionPromise).rejects.toThrow(HostConcurrentlyModifiedError)
		expect(open).not.toHaveBeenCalled()
		expect(createTransport).not.toHaveBeenCalled()

		const finalHost = await hosts.findById({ organizationId }, hostId)
		expect(finalHost?.status).toBe("error")
		expect(finalHost?.provisioningAttemptId).toBeNull()
		expect(finalHost?.provisioningClaimedAt).toBeNull()
	})

	it("rejects a re-trust attempted after the claim has committed but before the connection begins, then completes provisioning on the original fingerprint", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-retrust-mid-flight")

		let releaseGate: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve
		})
		let signalConnectStarted: () => void = () => {}
		const connectStarted = new Promise<void>((resolve) => {
			signalConnectStarted = resolve
		})

		let observedFingerprint: string | undefined
		const gatedTransport = (): HostTransport => {
			const inner = createFakeTransport({
				...PROVISIONABLE,
				"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
			})
			return {
				state: inner.state,
				canForward: inner.canForward,
				forward: () => Promise.reject(new Error("not forwarded in this test")),
				connect: async (options) => {
					observedFingerprint = options.expectedFingerprint
					signalConnectStarted()
					await gate
					await inner.connect(options)
				},
				exec: inner.exec,
				close: inner.close,
			}
		}

		const provisionController = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(gatedTransport),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})
		const retrustController = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => ROTATED_HOST_KEY_BLOB),
			createTransport: vi.fn(),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})

		const ctx = actorFor(organizationId, memberId)
		const provisionPromise = provisionController.provision(ctx, hostId)
		try {
			await connectStarted
			await expect(
				retrustController.retrustHostKey(ctx, hostId, {
					hostKeyFingerprint: ROTATED_FINGERPRINT,
				}),
			).rejects.toThrow(HostProvisioningInProgressError)
		} finally {
			releaseGate()
			await provisionPromise.catch(() => {})
		}

		const provisionResult = await provisionPromise
		expect(provisionResult?.status).toBe("ready")
		expect(observedFingerprint).toBe(EXPECTED_FINGERPRINT)

		const finalHost = await hosts.findById({ organizationId }, hostId)
		expect(finalHost?.hostKeyFingerprint).toBe(EXPECTED_FINGERPRINT)
	})

	it("lets re-trust succeed once provisioning has completed and status is no longer provisioning", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } = await seedProvisionableHost(
			"org-retrust-after-complete",
		)
		const ctx = actorFor(organizationId, memberId)

		const provisionController = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(() =>
				createFakeTransport({
					...PROVISIONABLE,
					"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
				}),
			),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})
		await provisionController.provision(ctx, hostId)
		expect((await hosts.findById({ organizationId }, hostId))?.status).toBe("ready")

		const retrustController = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => ROTATED_HOST_KEY_BLOB),
			createTransport: vi.fn(),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(db, sendJobDouble),
		})
		const retrusted = await retrustController.retrustHostKey(ctx, hostId, {
			hostKeyFingerprint: ROTATED_FINGERPRINT,
		})

		expect(retrusted?.hostKeyFingerprint).toBe(ROTATED_FINGERPRINT)
	})

	it("lets re-trust succeed once the provisioning claim has gone stale", async () => {
		const { organizationId, memberId, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-retrust-stale-claim")
		await hosts.claimForProvisioning({ organizationId }, hostId, "pending")
		await backdateProvisioningClaim(hostId, PROVISIONING_LEASE_MS + 1_000)

		const retrustController = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => ROTATED_HOST_KEY_BLOB),
			createTransport: vi.fn(),
			evictHost: () => undefined,
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction: createHostControllerTransaction(testDb(), sendJobDouble),
		})
		const ctx = actorFor(organizationId, memberId)
		const retrusted = await retrustController.retrustHostKey(ctx, hostId, {
			hostKeyFingerprint: ROTATED_FINGERPRINT,
		})

		expect(retrusted?.hostKeyFingerprint).toBe(ROTATED_FINGERPRINT)
		const finalHost = await hosts.findById({ organizationId }, hostId)
		expect(finalHost?.status).toBe("provisioning")
	})
})

describe("shared read connections open, read and close outside every transaction (real Postgres)", () => {
	afterAll(async () => {
		await teardownTestDb()
	})

	const seedReadyHost = async (slugPrefix: string) => {
		const organizationId = await seedOrganization(slugPrefix)
		const memberId = await seedMember(organizationId)
		const db = testDb()
		const hosts = createHostRepository(db)
		const sshKeys = createSshKeyRepository(db)
		const sshKeyRow = await sshKeys.insert(
			{ organizationId },
			{
				name: `${slugPrefix}-key`,
				publicKey: "ssh-ed25519 AAAA...",
				privateKeyEncrypted: "sealed",
				privateKeyKeyId: "k1",
			},
		)
		trackSshKeyId(sshKeyRow.id)
		const created = await hosts.insert(
			{ organizationId },
			{
				name: `${slugPrefix}-host`,
				hostname: "10.0.0.95",
				port: 22,
				username: "mcc",
				osRelease: "systemd 252",
				osId: "debian",
				osName: "Debian GNU/Linux 12 (bookworm)",
				failedUnits: null,
				teardownError: null,
				teardownRequestedAt: null,
				sshKeyId: sshKeyRow.id,
				hostKeyAlgorithm: "ssh-ed25519",
				hostKeyFingerprint: EXPECTED_FINGERPRINT,
				hostKeyTrustedBy: memberId,
				hostKeyTrustedByLabel: "actor@example.com",
				hostKeyTrustedAt: new Date(),
				status: "ready",
			},
		)
		trackHostId(created.id)
		return { organizationId, memberId, db, hosts, sshKeys, hostId: created.id }
	}

	it("C8: leases, reads and evicts with no transaction open, and evicts only after each commit", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedReadyHost("org-reuse-sightings")
		let openTransactions = 0
		const inner = createHostControllerTransaction(db, sendJobDouble)
		const withTransaction: WithTransaction = async (fn) => {
			openTransactions += 1
			try {
				return await inner(fn)
			} finally {
				openTransactions -= 1
			}
		}
		const sightings: Array<{ what: string; insideTransaction: boolean }> = []
		const sight = (what: string) =>
			sightings.push({ what, insideTransaction: openTransactions > 0 })
		const readConnections = createReadConnections({
			createTransport: () => {
				const transport = createFakeTransport()
				return {
					...transport,
					connect: async (options: ConnectOptions) => {
						sight("connect")
						await transport.connect(options)
					},
					forwardUntil: async (port: number, signal: AbortSignal) => {
						sight("forward")
						return await transport.forwardUntil(port, signal)
					},
					destroy: () => {
						sight("destroy")
						transport.destroy()
					},
				}
			},
			idleMs: READ_CONNECTION_IDLE_MS,
			hardAgeMs: READ_CONNECTION_HARD_AGE_MS,
			channelLimit: READ_CONNECTION_CHANNEL_LIMIT,
			now: () => Date.now(),
		})
		const secrets = { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() }
		const readerDeps = { hosts, sshKeys, secrets, readConnections }
		const scope = { organizationId }
		const readOnce = async () => {
			const leased = await leaseHostReader(readerDeps, scope, hostId, 10_000)
			if (leased.kind !== "leased") return leased.kind
			try {
				return await leased.reader.probePort(33333)
			} finally {
				leased.reader.release()
			}
		}
		const controller = createHostController({
			hosts,
			sshKeys,
			secrets,
			probeHostKey: vi.fn(async () => ROTATED_HOST_KEY_BLOB),
			createTransport: vi.fn(),
			evictHost: (evictedOrganization, evictedHost) => {
				sight("evict")
				readConnections.evict(hostReadKey(evictedOrganization, evictedHost))
			},
			instanceIdsOnHost: vi.fn(async () => []),
			now: () => new Date(),
			withTransaction,
		})
		const ctx = actorFor(organizationId, memberId)

		expect(await readOnce()).toBe("open")
		await controller.retrustHostKey(ctx, hostId, { hostKeyFingerprint: ROTATED_FINGERPRINT })
		expect(await readOnce()).toBe("open")
		await controller.remove(ctx, hostId)
		expect(await readOnce()).toBe("missing")

		expect(sightings.map((each) => each.what)).toEqual([
			"connect",
			"forward",
			"evict",
			"destroy",
			"connect",
			"forward",
			"evict",
			"destroy",
		])
		expect(sightings.every((each) => each.insideTransaction === false)).toBe(true)
	})

	const actorFor = (organizationId: string, memberId: string): ActorContext => ({
		organizationId,
		memberId,
		actorLabel: "actor@example.com",
		role: "owner",
	})
})

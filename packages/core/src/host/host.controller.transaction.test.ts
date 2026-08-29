import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
import { createFakeTransport, type HostTransport } from "@open-mcc/transport"
import { sql } from "drizzle-orm"
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
	HostProvisioningInProgressError,
	type WithTransaction,
} from "./host.controller"
import { createHostRepository } from "./host.repository"

const encodeAlgorithmBlob = (algorithm: string, extra: Buffer = Buffer.alloc(0)): Buffer => {
	const name = Buffer.from(algorithm, "ascii")
	const length = Buffer.alloc(4)
	length.writeUInt32BE(name.length, 0)
	return Buffer.concat([length, name, extra])
}

const HOST_KEY_BLOB = encodeAlgorithmBlob("ssh-ed25519", Buffer.from("tx-test-key-material"))
const EXPECTED_FINGERPRINT = fingerprintFromKey(HOST_KEY_BLOB)

const throwingAudit = {
	record: vi.fn(async () => Promise.reject(new Error("audit insert failed"))),
}

const baseDeps = (): Omit<HostControllerDeps, "withTransaction" | "hosts"> => ({
	sshKeys: { findById: vi.fn(async () => undefined) },
	secrets: { activeKeyId: "k1", seal: vi.fn(), open: vi.fn() },
	probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
	createTransport: vi.fn(),
	instancesRoot: "/var/lib/open-mcc-manager",
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
				db.transaction((tx) => fn({ hosts: createHostRepository(tx), audit: throwingAudit })),
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
				db.transaction((tx) => fn({ hosts: createHostRepository(tx), audit: throwingAudit })),
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
			withTransaction: createHostControllerTransaction(db),
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

	it("lets exactly one of two concurrent provision calls on the same host succeed", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-lock-race")

		const controller = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(() =>
				createFakeTransport({
					"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
				}),
			),
			instancesRoot: "/var/lib/open-mcc-manager",
			withTransaction: createHostControllerTransaction(db),
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
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
			HostConcurrentlyModifiedError,
		)

		const final = await hosts.findById({ organizationId }, hostId)
		expect(final?.status).toBe("ready")
	})

	it("does not re-claim a host that is already provisioning", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-lock-stuck")
		await hosts.claimForProvisioning({ organizationId }, hostId, "pending")

		const createTransport = vi.fn(() =>
			createFakeTransport({
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
			instancesRoot: "/var/lib/open-mcc-manager",
			withTransaction: createHostControllerTransaction(db),
		})

		const ctx = actorFor(organizationId, memberId)
		await expect(controller.provision(ctx, hostId)).rejects.toThrow(HostConcurrentlyModifiedError)

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
			instancesRoot: "/var/lib/open-mcc-manager",
			withTransaction: createHostControllerTransaction(db),
		})

		const ctx = actorFor(organizationId, memberId)
		await expect(controller.remove(ctx, hostId)).rejects.toThrow(HostProvisioningInProgressError)

		const stillThere = await hosts.findById({ organizationId }, hostId)
		expect(stillThere?.status).toBe("provisioning")
	})

	it("still deletes a host in any other status", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-allow-delete")

		const controller = createHostController({
			hosts,
			sshKeys,
			secrets: { open: vi.fn(() => "PRIVATE KEY"), activeKeyId: "k1", seal: vi.fn() },
			probeHostKey: vi.fn(async () => HOST_KEY_BLOB),
			createTransport: vi.fn(),
			instancesRoot: "/var/lib/open-mcc-manager",
			withTransaction: createHostControllerTransaction(db),
		})

		const ctx = actorFor(organizationId, memberId)
		await expect(controller.remove(ctx, hostId)).resolves.toBe(true)
		expect(await hosts.findById({ organizationId }, hostId)).toBeUndefined()
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
				"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
			})
			return {
				state: inner.state,
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
			instancesRoot: "/var/lib/open-mcc-manager",
			withTransaction: createHostControllerTransaction(db),
		})

		const ctx = actorFor(organizationId, memberId)
		const provisionPromise = controller.provision(ctx, hostId)
		await connectStarted

		await expect(controller.remove(ctx, hostId)).rejects.toThrow(HostProvisioningInProgressError)

		releaseGate()
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
					"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
				}),
			),
			instancesRoot: "/var/lib/open-mcc-manager",
			withTransaction: createHostControllerTransaction(db),
		})

		const ctx = actorFor(organizationId, memberId)
		await controller.provision(ctx, hostId)
		expect((await hosts.findById({ organizationId }, hostId))?.status).toBe("ready")

		await expect(controller.remove(ctx, hostId)).resolves.toBe(true)
		expect(await hosts.findById({ organizationId }, hostId)).toBeUndefined()
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
			createHostControllerTransaction(db),
		)

		const sightings: boolean[] = []
		const instrumentedTransport = (): HostTransport => {
			const inner = createFakeTransport({
				"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
			})
			return {
				state: inner.state,
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
			instancesRoot: "/var/lib/open-mcc-manager",
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
			db.transaction(async (tx) => {
				await tx.execute(sql`set local idle_in_transaction_session_timeout = '200ms'`)
				return fn({ hosts: createHostRepository(tx), audit: createAuditRepository(tx) })
			})

		const slowTransport = (): HostTransport => {
			const inner = createFakeTransport({
				"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
			})
			return {
				state: inner.state,
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
			instancesRoot: "/var/lib/open-mcc-manager",
			withTransaction: withShortIdleTimeout,
		})

		const ctx = actorFor(organizationId, memberId)
		const result = await controller.provision(ctx, hostId)

		expect(result?.status).toBe("ready")
		expect(await hosts.findById({ organizationId }, hostId)).toMatchObject({ status: "ready" })
	})
})

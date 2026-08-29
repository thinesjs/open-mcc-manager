import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
import { createFakeTransport, type HostTransport } from "@open-mcc/transport"
import { afterAll, describe, expect, it, vi } from "vitest"
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

	it("blocks a concurrent delete until the in-flight provisioning transaction commits", async () => {
		const { organizationId, memberId, db, hosts, sshKeys, hostId } =
			await seedProvisionableHost("org-lock-delete")

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

		const removePromise = controller.remove(ctx, hostId)
		const raceResult = await Promise.race([
			removePromise.then(() => "removed" as const),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 150)),
		])
		expect(raceResult).toBe("timeout")

		releaseGate()
		const [provisionResult, removeResult] = await Promise.all([provisionPromise, removePromise])

		expect(provisionResult?.status).toBe("ready")
		expect(removeResult).toBe(true)
		expect(await hosts.findById({ organizationId }, hostId)).toBeUndefined()
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

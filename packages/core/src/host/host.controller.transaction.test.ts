import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
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
	createHostController,
	createHostControllerTransaction,
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

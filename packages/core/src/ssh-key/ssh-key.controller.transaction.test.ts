import { randomUUID } from "node:crypto"
import type { Role } from "@open-mcc/contracts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AuditEntry } from "../audit/audit.repository"
import type { ActorContext } from "../host/host.controller"
import { seedOrganization, teardownTestDb, testDb, trackHostId, trackSshKeyId } from "../test/db"
import {
	createSshKeyController,
	type SshKeyControllerDeps,
	SshKeyInUseError,
	type WithSshKeyTransaction,
} from "./ssh-key.controller"
import { createSshKeyRepository } from "./ssh-key.repository"

const db = testDb()
const repo = createSshKeyRepository(db)

let organizationId = ""
let audited: AuditEntry[] = []

const withTransaction: WithSshKeyTransaction = (fn) =>
	db.transaction().execute((tx) =>
		fn({
			sshKeys: createSshKeyRepository(tx),
			audit: {
				record: async (_scope, entry) => {
					audited.push(entry)
					return {
						id: randomUUID(),
						organizationId: _scope.organizationId,
						actorId: entry.actorId,
						actorLabel: entry.actorLabel,
						action: entry.action,
						subjectType: entry.subjectType,
						subjectId: entry.subjectId,
						detail: entry.detail,
						createdAt: new Date(),
					}
				},
			},
		}),
	)

const deps: SshKeyControllerDeps = {
	sshKeys: repo,
	secrets: { seal: (plaintext) => ({ ciphertext: `sealed:${plaintext}`, keyId: "k1" }) },
	generateKeyPair: (_name: string) => ({
		publicKey: "ssh-ed25519 AAAAtest",
		privateKey: "private-key",
	}),
	withTransaction,
}

const controller = createSshKeyController(deps)

const actor = (role: Role = "owner"): ActorContext => ({
	organizationId,
	memberId: randomUUID(),
	actorLabel: "owner@example.com",
	role,
})

const seedSshKey = async (name: string): Promise<string> => {
	const created = await repo.insert(
		{ organizationId },
		{
			name,
			publicKey: "ssh-ed25519 AAAAtest",
			privateKeyEncrypted: "sealed",
			privateKeyKeyId: "k1",
		},
	)
	trackSshKeyId(created.id)
	return created.id
}

const seedHostUsing = async (sshKeyId: string): Promise<void> => {
	const id = randomUUID()
	await db
		.insertInto("host")
		.values({ id, organizationId, name: `vps-${id.slice(0, 8)}`, hostname: "10.0.0.1", sshKeyId })
		.execute()
	trackHostId(id)
}

const messageOfRefusedDelete = async (sshKeyId: string): Promise<string> => {
	try {
		await controller.remove(actor(), sshKeyId)
	} catch (error) {
		if (error instanceof Error) return error.message
		throw new Error("the controller threw a value that is not an Error")
	}
	throw new Error("the delete was expected to fail")
}

beforeAll(async () => {
	organizationId = await seedOrganization("ssh-key-controller")
})

afterAll(async () => {
	await teardownTestDb()
})

describe("ssh key controller against real Postgres", () => {
	it("refuses to delete a key an enrolled host references, and rolls the audit row back with it", async () => {
		audited = []
		const sshKeyId = await seedSshKey("in-use")
		await seedHostUsing(sshKeyId)

		await expect(controller.remove(actor(), sshKeyId)).rejects.toBeInstanceOf(SshKeyInUseError)

		expect(audited).toEqual([])
		const stillThere = await repo.findById({ organizationId }, sshKeyId)
		expect(stillThere?.id).toBe(sshKeyId)
	})

	it("names no constraint, table or tenant in the error it raises", async () => {
		audited = []
		const sshKeyId = await seedSshKey("in-use-message")
		await seedHostUsing(sshKeyId)

		const message = await messageOfRefusedDelete(sshKeyId)

		expect(message).not.toContain("host_sshKey_org_fk")
		expect(message).not.toContain(organizationId)
	})

	it("deletes a key no host references and audits it in the same transaction", async () => {
		audited = []
		const sshKeyId = await seedSshKey("unused")

		expect(await controller.remove(actor(), sshKeyId)).toBe(true)

		expect(audited.map((entry) => entry.action)).toEqual(["sshKey.delete"])
		expect(await repo.findById({ organizationId }, sshKeyId)).toBeUndefined()
	})

	it("stores only the sealed private key and hands back the public projection", async () => {
		audited = []
		const created = await controller.create(actor(), { name: "generated", type: "ed25519" })
		trackSshKeyId(created.id)

		expect(Object.keys(created).sort()).toEqual(["createdAt", "id", "name", "publicKey"])
		const stored = await repo.findById({ organizationId }, created.id)
		expect(stored?.privateKeyEncrypted).toBe("sealed:private-key")
		expect(JSON.stringify(created)).not.toContain("private-key")
	})
})

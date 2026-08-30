import { randomUUID } from "node:crypto"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { createDb } from "../client"

const requireTestDatabaseUrl = (): string => {
	const url = process.env.TEST_DATABASE_URL
	if (!url) throw new Error("TEST_DATABASE_URL is required to run repository tests")
	return url
}

const db = createDb(requireTestDatabaseUrl())

type SeededIds = {
	organizationIds: string[]
	userIds: string[]
	memberIds: string[]
	hostIds: string[]
	sshKeyIds: string[]
	auditEventIds: string[]
}

const emptySeededIds = (): SeededIds => ({
	organizationIds: [],
	userIds: [],
	memberIds: [],
	hostIds: [],
	sshKeyIds: [],
	auditEventIds: [],
})

let seeded = emptySeededIds()

const seedOrganization = async () => {
	const id = randomUUID()
	await db
		.insertInto("organization")
		.values({ id, name: "org", slug: `org-${id.slice(0, 8)}` })
		.execute()
	seeded.organizationIds.push(id)
	return id
}

const seedMember = async (organizationId: string) => {
	const userId = randomUUID()
	await db
		.insertInto("user")
		.values({ id: userId, name: "actor", email: `${userId}@example.com` })
		.execute()
	seeded.userIds.push(userId)
	const memberId = randomUUID()
	await db.insertInto("member").values({ id: memberId, organizationId, userId }).execute()
	seeded.memberIds.push(memberId)
	return memberId
}

describe("tenant foreign key integrity", () => {
	afterEach(async () => {
		const created = seeded
		seeded = emptySeededIds()
		const steps: Array<() => Promise<void>> = [
			async () => {
				if (created.auditEventIds.length > 0) {
					await db.deleteFrom("auditEvent").where("id", "in", created.auditEventIds).execute()
				}
			},
			async () => {
				if (created.hostIds.length > 0) {
					await db.deleteFrom("host").where("id", "in", created.hostIds).execute()
				}
			},
			async () => {
				if (created.sshKeyIds.length > 0) {
					await db.deleteFrom("sshKey").where("id", "in", created.sshKeyIds).execute()
				}
			},
			async () => {
				if (created.memberIds.length > 0) {
					await db.deleteFrom("member").where("id", "in", created.memberIds).execute()
				}
			},
			async () => {
				if (created.userIds.length > 0) {
					await db.deleteFrom("user").where("id", "in", created.userIds).execute()
				}
			},
			async () => {
				if (created.organizationIds.length > 0) {
					await db.deleteFrom("organization").where("id", "in", created.organizationIds).execute()
				}
			},
		]

		for (const step of steps) {
			try {
				await step()
			} catch (error) {
				console.error("tenant-fk.test.ts teardown: cleanup step failed", error)
			}
		}
	})

	afterAll(async () => {
		await db.destroy()
	})

	it("keeps the host row and nulls only hostKeyTrustedBy when the trusting member is deleted, preserving hostKeyTrustedByLabel", async () => {
		const organizationId = await seedOrganization()
		const memberId = await seedMember(organizationId)
		const hostId = randomUUID()
		await db
			.insertInto("host")
			.values({
				id: hostId,
				organizationId,
				name: "vps",
				hostname: "10.0.0.9",
				hostKeyTrustedBy: memberId,
				hostKeyTrustedByLabel: memberId,
				hostKeyFingerprint: "SHA256:tenant-fk-test",
				hostKeyAlgorithm: "ssh-ed25519",
				hostKeyTrustedAt: new Date(),
			})
			.execute()
		seeded.hostIds.push(hostId)

		await db.deleteFrom("member").where("id", "=", memberId).execute()

		const found = await db
			.selectFrom("host")
			.selectAll()
			.where("id", "=", hostId)
			.executeTakeFirst()
		if (!found) throw new Error("expected the host row to survive the member delete")
		expect(found.organizationId).toBe(organizationId)
		expect(found.hostKeyTrustedBy).toBeNull()
		expect(found.hostKeyTrustedByLabel).toBe(memberId)
	})

	it("keeps the auditEvent row and nulls only actorId when the acting member is deleted, preserving actorLabel", async () => {
		const organizationId = await seedOrganization()
		const memberId = await seedMember(organizationId)
		const eventId = randomUUID()
		await db
			.insertInto("auditEvent")
			.values({
				id: eventId,
				organizationId,
				actorId: memberId,
				actorLabel: memberId,
				action: "host.create",
				subjectType: "host",
				subjectId: "n/a",
			})
			.execute()
		seeded.auditEventIds.push(eventId)

		await db.deleteFrom("member").where("id", "=", memberId).execute()

		const found = await db
			.selectFrom("auditEvent")
			.selectAll()
			.where("id", "=", eventId)
			.executeTakeFirst()
		if (!found) throw new Error("expected the auditEvent row to survive the member delete")
		expect(found.organizationId).toBe(organizationId)
		expect(found.actorId).toBeNull()
		expect(found.actorLabel).toBe(memberId)
	})

	it("rejects a host in one organization referencing an sshKey from another", async () => {
		const organizationA = await seedOrganization()
		const organizationB = await seedOrganization()
		const keyId = randomUUID()
		await db
			.insertInto("sshKey")
			.values({
				id: keyId,
				organizationId: organizationA,
				name: "key",
				publicKey: "pub",
				privateKeyEncrypted: "enc",
				privateKeyKeyId: "kid",
			})
			.execute()
		seeded.sshKeyIds.push(keyId)

		await expect(
			db
				.insertInto("host")
				.values({
					id: randomUUID(),
					organizationId: organizationB,
					name: "vps-cross",
					hostname: "10.0.0.10",
					sshKeyId: keyId,
				})
				.execute(),
		).rejects.toThrow()
	})
})

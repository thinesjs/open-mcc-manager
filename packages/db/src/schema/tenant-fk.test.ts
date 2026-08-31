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
	instanceIds: string[]
	instanceConfigIds: string[]
}

const emptySeededIds = (): SeededIds => ({
	organizationIds: [],
	userIds: [],
	memberIds: [],
	hostIds: [],
	sshKeyIds: [],
	auditEventIds: [],
	instanceIds: [],
	instanceConfigIds: [],
})

let seeded = emptySeededIds()

afterAll(async () => {
	await db.destroy()
})

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
				if (created.instanceConfigIds.length > 0) {
					await db
						.deleteFrom("instanceConfig")
						.where("id", "in", created.instanceConfigIds)
						.execute()
				}
			},
			async () => {
				if (created.instanceIds.length > 0) {
					await db.deleteFrom("instance").where("id", "in", created.instanceIds).execute()
				}
			},
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

	it("rejects a second member row for the same user in the same organization", async () => {
		const organizationId = await seedOrganization()
		const memberId = await seedMember(organizationId)
		const existing = await db
			.selectFrom("member")
			.select("userId")
			.where("id", "=", memberId)
			.executeTakeFirstOrThrow()

		await expect(
			db
				.insertInto("member")
				.values({ id: randomUUID(), organizationId, userId: existing.userId })
				.execute(),
		).rejects.toThrow(/member_org_user_unique/)

		const rows = await db
			.selectFrom("member")
			.select("id")
			.where("organizationId", "=", organizationId)
			.execute()
		expect(rows).toHaveLength(1)
	})

	it("still lets one user hold a membership in a second organization", async () => {
		const firstOrganizationId = await seedOrganization()
		const memberId = await seedMember(firstOrganizationId)
		const existing = await db
			.selectFrom("member")
			.select("userId")
			.where("id", "=", memberId)
			.executeTakeFirstOrThrow()

		const secondOrganizationId = await seedOrganization()
		const secondMemberId = randomUUID()
		await db
			.insertInto("member")
			.values({
				id: secondMemberId,
				organizationId: secondOrganizationId,
				userId: existing.userId,
			})
			.execute()
		seeded.memberIds.push(secondMemberId)

		const rows = await db
			.selectFrom("member")
			.select("organizationId")
			.where("userId", "=", existing.userId)
			.execute()
		expect(rows.map((row) => row.organizationId).sort()).toEqual(
			[firstOrganizationId, secondOrganizationId].sort(),
		)
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

describe("instance tenant integrity", () => {
	afterEach(async () => {
		const created = seeded
		seeded = emptySeededIds()
		if (created.instanceConfigIds.length > 0) {
			await db.deleteFrom("instanceConfig").where("id", "in", created.instanceConfigIds).execute()
		}
		if (created.instanceIds.length > 0) {
			await db.deleteFrom("instance").where("id", "in", created.instanceIds).execute()
		}
		if (created.hostIds.length > 0) {
			await db.deleteFrom("host").where("id", "in", created.hostIds).execute()
		}
		if (created.memberIds.length > 0) {
			await db.deleteFrom("member").where("id", "in", created.memberIds).execute()
		}
		if (created.userIds.length > 0) {
			await db.deleteFrom("user").where("id", "in", created.userIds).execute()
		}
		if (created.organizationIds.length > 0) {
			await db.deleteFrom("organization").where("id", "in", created.organizationIds).execute()
		}
	})

	const seedHost = async (organizationId: string) => {
		const id = randomUUID()
		await db
			.insertInto("host")
			.values({ id, organizationId, name: `h-${id.slice(0, 8)}`, hostname: "10.0.0.1" })
			.execute()
		seeded.hostIds.push(id)
		return id
	}

	it("rejects an instance in one organization referencing a host from another", async () => {
		const orgA = await seedOrganization()
		const orgB = await seedOrganization()
		const hostInB = await seedHost(orgB)

		await expect(
			db
				.insertInto("instance")
				.values({
					id: randomUUID(),
					organizationId: orgA,
					hostId: hostInB,
					name: "cross",
					minecraftAccount: "a@example.com",
				})
				.execute(),
		).rejects.toThrow(/instance_host_org_fk/)
	})

	it("refuses to delete a host that still has an instance on it", async () => {
		const org = await seedOrganization()
		const hostId = await seedHost(org)
		const instanceId = randomUUID()
		await db
			.insertInto("instance")
			.values({
				id: instanceId,
				organizationId: org,
				hostId,
				name: "live",
				minecraftAccount: "a@example.com",
			})
			.execute()
		seeded.instanceIds.push(instanceId)

		await expect(db.deleteFrom("host").where("id", "=", hostId).execute()).rejects.toThrow(
			/instance_host_org_fk/,
		)
	})

	it("keeps the config row and nulls only authorId when the author is deleted", async () => {
		const org = await seedOrganization()
		const hostId = await seedHost(org)
		const memberId = await seedMember(org)
		const instanceId = randomUUID()
		await db
			.insertInto("instance")
			.values({
				id: instanceId,
				organizationId: org,
				hostId,
				name: "cfg",
				minecraftAccount: "a@example.com",
			})
			.execute()
		seeded.instanceIds.push(instanceId)
		const configId = randomUUID()
		await db
			.insertInto("instanceConfig")
			.values({
				id: configId,
				organizationId: org,
				instanceId,
				version: 1,
				document: JSON.stringify({ serverAddress: "play.example.com" }),
				authorId: memberId,
				authorLabel: "author@example.com",
			})
			.execute()
		seeded.instanceConfigIds.push(configId)

		await db.deleteFrom("member").where("id", "=", memberId).execute()

		const row = await db
			.selectFrom("instanceConfig")
			.selectAll()
			.where("id", "=", configId)
			.executeTakeFirst()
		expect(row?.authorId).toBeNull()
		expect(row?.authorLabel).toBe("author@example.com")
		expect(row?.organizationId).toBe(org)
	})

	it("refuses an auth claim id without a claim timestamp", async () => {
		const org = await seedOrganization()
		const hostId = await seedHost(org)
		const instanceId = randomUUID()

		await expect(
			db
				.insertInto("instance")
				.values({
					id: instanceId,
					organizationId: org,
					hostId,
					name: "noclaim",
					minecraftAccount: "a@example.com",
					authClaimId: "attempt-1",
				})
				.execute(),
		).rejects.toThrow(/instance_auth_requires_lease/)
	})
})

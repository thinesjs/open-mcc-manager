import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { createDb } from "../client"
import { auditEvent, host, member, organization, sshKey, user } from "./index"

const db = createDb(
	process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:55432/postgres",
)

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
	await db.insert(organization).values({ id, name: "org", slug: `org-${id.slice(0, 8)}` })
	seeded.organizationIds.push(id)
	return id
}

const seedMember = async (organizationId: string) => {
	const userId = randomUUID()
	await db.insert(user).values({ id: userId, name: "actor", email: `${userId}@example.com` })
	seeded.userIds.push(userId)
	const memberId = randomUUID()
	await db.insert(member).values({ id: memberId, organizationId, userId })
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
					await db.delete(auditEvent).where(inArray(auditEvent.id, created.auditEventIds))
				}
			},
			async () => {
				if (created.hostIds.length > 0) {
					await db.delete(host).where(inArray(host.id, created.hostIds))
				}
			},
			async () => {
				if (created.sshKeyIds.length > 0) {
					await db.delete(sshKey).where(inArray(sshKey.id, created.sshKeyIds))
				}
			},
			async () => {
				if (created.memberIds.length > 0) {
					await db.delete(member).where(inArray(member.id, created.memberIds))
				}
			},
			async () => {
				if (created.userIds.length > 0) {
					await db.delete(user).where(inArray(user.id, created.userIds))
				}
			},
			async () => {
				if (created.organizationIds.length > 0) {
					await db.delete(organization).where(inArray(organization.id, created.organizationIds))
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
		await db.$client.end()
	})

	it("keeps the host row and nulls only hostKeyTrustedBy when the trusting member is deleted", async () => {
		const organizationId = await seedOrganization()
		const memberId = await seedMember(organizationId)
		const hostId = randomUUID()
		await db.insert(host).values({
			id: hostId,
			organizationId,
			name: "vps",
			hostname: "10.0.0.9",
			hostKeyTrustedBy: memberId,
		})
		seeded.hostIds.push(hostId)

		await db.delete(member).where(eq(member.id, memberId))

		const [found] = await db.select().from(host).where(eq(host.id, hostId))
		if (!found) throw new Error("expected the host row to survive the member delete")
		expect(found.organizationId).toBe(organizationId)
		expect(found.hostKeyTrustedBy).toBeNull()
	})

	it("keeps the auditEvent row and nulls only actorId when the acting member is deleted", async () => {
		const organizationId = await seedOrganization()
		const memberId = await seedMember(organizationId)
		const eventId = randomUUID()
		await db.insert(auditEvent).values({
			id: eventId,
			organizationId,
			actorId: memberId,
			action: "host.create",
			subjectType: "host",
			subjectId: "n/a",
		})
		seeded.auditEventIds.push(eventId)

		await db.delete(member).where(eq(member.id, memberId))

		const [found] = await db.select().from(auditEvent).where(eq(auditEvent.id, eventId))
		if (!found) throw new Error("expected the auditEvent row to survive the member delete")
		expect(found.organizationId).toBe(organizationId)
		expect(found.actorId).toBeNull()
	})

	it("rejects a host in one organization referencing an sshKey from another", async () => {
		const organizationA = await seedOrganization()
		const organizationB = await seedOrganization()
		const keyId = randomUUID()
		await db.insert(sshKey).values({
			id: keyId,
			organizationId: organizationA,
			name: "key",
			publicKey: "pub",
			privateKeyEncrypted: "enc",
			privateKeyKeyId: "kid",
		})
		seeded.sshKeyIds.push(keyId)

		await expect(
			db.insert(host).values({
				id: randomUUID(),
				organizationId: organizationB,
				name: "vps-cross",
				hostname: "10.0.0.10",
				sshKeyId: keyId,
			}),
		).rejects.toThrow()
	})
})

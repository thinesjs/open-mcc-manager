import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"
import { createDb } from "../client"
import { auditEvent, host, member, organization, sshKey, user } from "./index"

const db = createDb(
	process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:55432/postgres",
)

const seedOrganization = async () => {
	const id = randomUUID()
	await db.insert(organization).values({ id, name: "org", slug: `org-${id.slice(0, 8)}` })
	return id
}

const seedMember = async (organizationId: string) => {
	const userId = randomUUID()
	await db.insert(user).values({ id: userId, name: "actor", email: `${userId}@example.com` })
	const memberId = randomUUID()
	await db.insert(member).values({ id: memberId, organizationId, userId })
	return memberId
}

describe("tenant foreign key integrity", () => {
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

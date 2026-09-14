import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { seedMember, seedOrganization, teardownTestDb, testDb } from "../test/db"
import { createMemberRepository } from "./member.repository"

const repo = createMemberRepository(testDb())

afterAll(async () => {
	await teardownTestDb()
})

const seedOwner = async (organizationId: string): Promise<string> => {
	const id = await seedMember(organizationId)
	await testDb().updateTable("member").set({ role: "owner" }).where("id", "=", id).execute()
	return id
}

const userOf = async (memberId: string): Promise<string> => {
	const row = await testDb()
		.selectFrom("member")
		.select("userId")
		.where("id", "=", memberId)
		.executeTakeFirstOrThrow()
	return row.userId
}

const seedInvitation = async (organizationId: string, inviterMemberId: string): Promise<string> => {
	const id = randomUUID()
	await testDb()
		.insertInto("invitation")
		.values({
			id,
			organizationId,
			email: `${id}@example.com`,
			role: "viewer",
			status: "pending",
			expiresAt: new Date(Date.now() + 86_400_000),
			inviterId: await userOf(inviterMemberId),
		})
		.execute()
	return id
}

const pendingIds = async (organizationId: string): Promise<string[]> =>
	(await repo.listPendingInvitations({ organizationId })).map((row) => row.id)

describe("member repository organization scoping", () => {
	it("lists its own members with the email they sign in with, and no one else's", async () => {
		const orgA = await seedOrganization("members-a")
		const orgB = await seedOrganization("members-b")
		const ownerA = await seedOwner(orgA)
		const ownerB = await seedOwner(orgB)

		const rows = await repo.list({ organizationId: orgA })

		expect(rows.map((row) => row.id)).toEqual([ownerA])
		expect(rows[0]?.email).toBe(`${await userOf(ownerA)}@example.com`)
		expect(rows.map((row) => row.id)).not.toContain(ownerB)
	})

	it("cannot find, remove or count another organization's member", async () => {
		const orgA = await seedOrganization("members-a")
		const orgB = await seedOrganization("members-b")
		await seedOwner(orgA)
		const viewerA = await seedMember(orgA)

		expect(await repo.findById({ organizationId: orgB }, viewerA)).toBeUndefined()
		expect(await repo.delete({ organizationId: orgB }, viewerA)).toBe(false)
		expect((await repo.findById({ organizationId: orgA }, viewerA))?.role).toBe("viewer")
		expect(await repo.countOwners({ organizationId: orgA })).toBe(1)
		expect(await repo.countOwners({ organizationId: orgB })).toBe(0)
	})

	it("cannot see or cancel another organization's invitation", async () => {
		const orgA = await seedOrganization("members-a")
		const orgB = await seedOrganization("members-b")
		const ownerA = await seedOwner(orgA)
		const invitation = await seedInvitation(orgA, ownerA)

		expect(await pendingIds(orgB)).not.toContain(invitation)
		expect(await repo.cancelInvitation({ organizationId: orgB }, invitation)).toBe(false)
		expect(await pendingIds(orgA)).toContain(invitation)
	})

	it("cancels only the pending invitations one person sent, in its own organization", async () => {
		const orgA = await seedOrganization("members-a")
		const orgB = await seedOrganization("members-b")
		const ownerA = await seedOwner(orgA)
		const otherOwnerA = await seedOwner(orgA)
		const sent = await seedInvitation(orgA, ownerA)
		const sentByOther = await seedInvitation(orgA, otherOwnerA)
		const ownerB = await seedOwner(orgB)
		const inOtherOrganization = await seedInvitation(orgB, ownerB)

		expect(await repo.cancelInvitationsSentBy({ organizationId: orgA }, await userOf(ownerA))).toBe(
			1,
		)
		expect(await repo.cancelInvitationsSentBy({ organizationId: orgA }, await userOf(ownerB))).toBe(
			0,
		)

		expect(await pendingIds(orgA)).toEqual([sentByOther])
		expect(await pendingIds(orgA)).not.toContain(sent)
		expect(await pendingIds(orgB)).toEqual([inOtherOrganization])
	})
})

import type { Executor } from "@open-mcc/db"
import { sql } from "kysely"
import type { OrgScope } from "../host/host.repository"

export const createMemberRepository = (db: Executor) => {
	const membersWithUser = (scope: OrgScope) =>
		db
			.selectFrom("member")
			.innerJoin("user", "user.id", "member.userId")
			.select([
				"member.id",
				"member.userId",
				"member.role",
				"member.createdAt",
				"user.name",
				"user.email",
			])
			.where("member.organizationId", "=", scope.organizationId)

	return {
		lock: async (scope: OrgScope): Promise<void> => {
			const key = `member:${scope.organizationId}`
			await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(db)
		},

		list: (scope: OrgScope) =>
			membersWithUser(scope).orderBy("member.createdAt", "asc").orderBy("member.id").execute(),

		findById: (scope: OrgScope, id: string) =>
			membersWithUser(scope).where("member.id", "=", id).executeTakeFirst(),

		countOwners: async (scope: OrgScope): Promise<number> => {
			const row = await db
				.selectFrom("member")
				.select((eb) => eb.fn.countAll<string>().as("owners"))
				.where("organizationId", "=", scope.organizationId)
				.where("role", "=", "owner")
				.executeTakeFirstOrThrow()
			return Number(row.owners)
		},

		delete: async (scope: OrgScope, id: string): Promise<boolean> => {
			const result = await db
				.deleteFrom("member")
				.where("organizationId", "=", scope.organizationId)
				.where("id", "=", id)
				.executeTakeFirst()
			return Number(result.numDeletedRows) > 0
		},

		listPendingInvitations: (scope: OrgScope) =>
			db
				.selectFrom("invitation")
				.select(["id", "email", "role", "expiresAt"])
				.where("organizationId", "=", scope.organizationId)
				.where("status", "=", "pending")
				.orderBy("createdAt", "asc")
				.orderBy("id")
				.execute(),

		cancelInvitation: async (scope: OrgScope, id: string): Promise<boolean> => {
			const result = await db
				.updateTable("invitation")
				.set({ status: "canceled" })
				.where("organizationId", "=", scope.organizationId)
				.where("id", "=", id)
				.where("status", "=", "pending")
				.executeTakeFirst()
			return Number(result.numUpdatedRows) > 0
		},

		cancelInvitationsSentBy: async (scope: OrgScope, userId: string): Promise<number> => {
			const result = await db
				.updateTable("invitation")
				.set({ status: "canceled" })
				.where("organizationId", "=", scope.organizationId)
				.where("inviterId", "=", userId)
				.where("status", "=", "pending")
				.executeTakeFirst()
			return Number(result.numUpdatedRows)
		},
	}
}

export type MemberRepository = ReturnType<typeof createMemberRepository>

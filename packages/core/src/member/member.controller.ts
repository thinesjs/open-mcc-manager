import { can, isRole, type MemberView, type PendingInvitation } from "@open-mcc/contracts"
import type { Db } from "@open-mcc/db"
import { type AuditRepository, createAuditRepository } from "../audit/audit.repository"
import { type ActorContext, ForbiddenError } from "../host/host.controller"
import type { OrgScope } from "../host/host.repository"
import type { RuntimeErrorReporter } from "../log/reporters"
import { createMemberRepository, type MemberRepository } from "./member.repository"

export type MemberTransactionRepos = {
	members: Pick<
		MemberRepository,
		"lock" | "findById" | "countOwners" | "delete" | "cancelInvitation" | "cancelInvitationsSentBy"
	>
	audit: Pick<AuditRepository, "record">
}

export type WithMemberTransaction = <T>(
	fn: (repos: MemberTransactionRepos) => Promise<T>,
) => Promise<T>

export const createMemberControllerTransaction = (db: Db): WithMemberTransaction => {
	const withTransaction: WithMemberTransaction = (fn) =>
		db
			.transaction()
			.execute((tx) =>
				fn({ members: createMemberRepository(tx), audit: createAuditRepository(tx) }),
			)
	return withTransaction
}

export type MemberControllerDeps = {
	members: Pick<MemberRepository, "list" | "listPendingInvitations">
	withTransaction: WithMemberTransaction
	revokeSessions: (scope: OrgScope, userId: string) => Promise<void>
	reportError: RuntimeErrorReporter
}

export class LastOwnerError extends Error {}

const requireMemberManage = (ctx: ActorContext): void => {
	if (!can(ctx.role, "member.manage")) throw new ForbiddenError("Forbidden: member.manage")
}

export const createMemberController = (deps: MemberControllerDeps) => ({
	list: async (ctx: ActorContext): Promise<MemberView[]> => {
		requireMemberManage(ctx)
		const rows = await deps.members.list({ organizationId: ctx.organizationId })
		return rows.flatMap((row) =>
			isRole(row.role)
				? [
						{
							id: row.id,
							name: row.name,
							email: row.email,
							role: row.role,
							self: row.id === ctx.memberId,
						},
					]
				: [],
		)
	},

	invitations: async (ctx: ActorContext): Promise<PendingInvitation[]> => {
		requireMemberManage(ctx)
		const rows = await deps.members.listPendingInvitations({ organizationId: ctx.organizationId })
		return rows.flatMap((row) =>
			row.role !== null && isRole(row.role)
				? [
						{
							id: row.id,
							email: row.email,
							role: row.role,
							expiresAt: row.expiresAt.toISOString(),
						},
					]
				: [],
		)
	},

	remove: async (ctx: ActorContext, memberId: string): Promise<boolean> => {
		requireMemberManage(ctx)
		if (memberId === ctx.memberId) {
			throw new ForbiddenError("Forbidden: an owner cannot remove themselves")
		}
		const scope = { organizationId: ctx.organizationId }

		const removed = await deps.withTransaction(async (repos) => {
			await repos.members.lock(scope)
			const caller = await repos.members.findById(scope, ctx.memberId)
			if (!caller || !isRole(caller.role) || !can(caller.role, "member.manage")) {
				throw new ForbiddenError("Forbidden: the caller no longer manages members")
			}
			const target = await repos.members.findById(scope, memberId)
			if (!target) return undefined
			if (target.role === "owner" && (await repos.members.countOwners(scope)) <= 1) {
				throw new LastOwnerError(`Member ${memberId} is the organization's last owner`)
			}

			await repos.members.delete(scope, memberId)
			const invitationsCancelled = await repos.members.cancelInvitationsSentBy(scope, target.userId)
			await repos.audit.record(scope, {
				actorId: ctx.memberId,
				actorLabel: ctx.actorLabel,
				action: "member.remove",
				subjectType: "member",
				subjectId: memberId,
				detail: {
					email: target.email,
					role: target.role,
					invitationsCancelled: String(invitationsCancelled),
				},
			})
			return target
		})
		if (!removed) return false

		try {
			await deps.revokeSessions(scope, removed.userId)
		} catch (error) {
			deps.reportError(
				"Ending a removed member's sessions failed after the removal committed",
				error instanceof Error ? error : String(error),
			)
		}
		return true
	},

	cancelInvitation: async (ctx: ActorContext, invitationId: string): Promise<boolean> => {
		requireMemberManage(ctx)
		const scope = { organizationId: ctx.organizationId }

		return deps.withTransaction(async (repos) => {
			const cancelled = await repos.members.cancelInvitation(scope, invitationId)
			if (cancelled) {
				await repos.audit.record(scope, {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "member.invite.cancel",
					subjectType: "invitation",
					subjectId: invitationId,
					detail: {},
				})
			}
			return cancelled
		})
	},
})

export type MemberController = ReturnType<typeof createMemberController>

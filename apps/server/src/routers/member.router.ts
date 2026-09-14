import { randomUUID } from "node:crypto"
import {
	type AcceptInvitationResult,
	acceptInvitationInput,
	invitationIdInput,
	inviteMemberInput,
	isRole,
	type MemberSelfView,
	memberIdInput,
	type PendingInvitation,
} from "@open-mcc/contracts"
import { createAuditRepository } from "@open-mcc/core"
import { InvitationNotFoundError } from "../errors"
import { protectedProcedure, publicProcedure, requireCapability, router } from "../trpc"

export const memberRouter = router({
	me: protectedProcedure.query(({ ctx }): MemberSelfView => ({ role: ctx.actor.role })),

	list: protectedProcedure.query(({ ctx }) => {
		requireCapability(ctx.actor.role, "member.manage")
		return ctx.memberController.list(ctx.actor)
	}),

	invitations: protectedProcedure.query(({ ctx }) => {
		requireCapability(ctx.actor.role, "member.manage")
		return ctx.memberController.invitations(ctx.actor)
	}),

	remove: protectedProcedure.input(memberIdInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "member.manage")
		return ctx.memberController.remove(ctx.actor, input.memberId)
	}),

	cancelInvitation: protectedProcedure.input(invitationIdInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "member.manage")
		return ctx.memberController.cancelInvitation(ctx.actor, input.invitationId)
	}),

	invite: protectedProcedure
		.input(inviteMemberInput)
		.mutation(async ({ ctx, input }): Promise<PendingInvitation> => {
			requireCapability(ctx.actor.role, "member.manage")
			const invitation = await ctx.auth.api.createInvitation({
				headers: ctx.headers,
				body: {
					email: input.email,
					role: input.role,
					organizationId: ctx.actor.organizationId,
				},
			})

			await createAuditRepository(ctx.db).record(
				{ organizationId: ctx.actor.organizationId },
				{
					actorId: ctx.actor.memberId,
					actorLabel: ctx.actor.actorLabel,
					action: "member.invite",
					subjectType: "invitation",
					subjectId: invitation.id,
					detail: { email: input.email, role: input.role },
				},
			)

			return {
				id: invitation.id,
				email: invitation.email,
				role: input.role,
				expiresAt: invitation.expiresAt,
			}
		}),

	acceptInvitation: publicProcedure
		.input(acceptInvitationInput)
		.mutation(async ({ ctx, input }): Promise<AcceptInvitationResult> => {
			const invitation = await ctx.db
				.selectFrom("invitation")
				.selectAll()
				.where("id", "=", input.invitationId)
				.executeTakeFirst()
			if (!invitation) {
				throw new InvitationNotFoundError(`Invitation not found: ${input.invitationId}`)
			}
			if (
				invitation.status !== "pending" ||
				invitation.expiresAt.getTime() < Date.now() ||
				!invitation.role ||
				!isRole(invitation.role)
			) {
				throw new InvitationNotFoundError(`Invitation not found: ${input.invitationId}`)
			}
			const role = invitation.role

			const signUpResult = await ctx.signupAuth.api.signUpEmail({
				body: { email: invitation.email, password: input.password, name: input.name },
			})

			const memberId = randomUUID()

			await ctx.db.transaction().execute(async (tx) => {
				const inviter = await tx
					.selectFrom("member")
					.select("id")
					.where("organizationId", "=", invitation.organizationId)
					.where("userId", "=", invitation.inviterId)
					.executeTakeFirst()
				if (!inviter) {
					throw new InvitationNotFoundError(`Invitation not found: ${input.invitationId}`)
				}

				await tx
					.insertInto("member")
					.values({
						id: memberId,
						organizationId: invitation.organizationId,
						userId: signUpResult.user.id,
						role,
					})
					.execute()

				const consumed = await tx
					.updateTable("invitation")
					.set({ status: "accepted" })
					.where("id", "=", invitation.id)
					.where("status", "=", "pending")
					.returningAll()
					.executeTakeFirst()
				if (!consumed) {
					throw new InvitationNotFoundError(`Invitation not found: ${input.invitationId}`)
				}

				await createAuditRepository(tx).record(
					{ organizationId: invitation.organizationId },
					{
						actorId: memberId,
						actorLabel: invitation.email,
						action: "member.accept",
						subjectType: "member",
						subjectId: memberId,
						detail: { invitationId: invitation.id, role },
					},
				)
			})

			return { accepted: true }
		}),
})

import { randomUUID } from "node:crypto"
import { acceptInvitationInput, inviteMemberInput } from "@open-mcc/contracts"
import { InvitationNotFoundError } from "../errors"
import { protectedProcedure, publicProcedure, requireCapability, router } from "../trpc"

export const memberRouter = router({
	invite: protectedProcedure.input(inviteMemberInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "member.manage")
		return ctx.auth.api.createInvitation({
			headers: ctx.headers,
			body: {
				email: input.email,
				role: input.role,
				organizationId: ctx.actor.organizationId,
			},
		})
	}),

	acceptInvitation: publicProcedure
		.input(acceptInvitationInput)
		.mutation(async ({ ctx, input }) => {
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
				!invitation.role
			) {
				throw new InvitationNotFoundError(`Invitation not found: ${input.invitationId}`)
			}

			const signUpResult = await ctx.signupAuth.api.signUpEmail({
				body: { email: invitation.email, password: input.password, name: input.name },
			})

			await ctx.db
				.insertInto("member")
				.values({
					id: randomUUID(),
					organizationId: invitation.organizationId,
					userId: signUpResult.user.id,
					role: invitation.role,
				})
				.execute()

			await ctx.db
				.updateTable("invitation")
				.set({ status: "accepted" })
				.where("id", "=", invitation.id)
				.where("status", "=", "pending")
				.execute()

			return {
				userId: signUpResult.user.id,
				organizationId: invitation.organizationId,
				role: invitation.role,
			}
		}),
})

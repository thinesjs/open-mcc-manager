import { createSshKeyInput, sshKeyIdInput } from "@open-mcc/contracts"
import { protectedProcedure, requireCapability, router } from "../trpc"

export const sshKeyRouter = router({
	list: protectedProcedure.query(({ ctx }) => {
		requireCapability(ctx.actor.role, "sshKey.manage")
		return ctx.sshKeyController.list(ctx.actor)
	}),

	create: protectedProcedure.input(createSshKeyInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "sshKey.manage")
		return ctx.sshKeyController.create(ctx.actor, input)
	}),

	remove: protectedProcedure.input(sshKeyIdInput).mutation(async ({ ctx, input }) => {
		requireCapability(ctx.actor.role, "sshKey.manage")
		const deleted = await ctx.sshKeyController.remove(ctx.actor, input.sshKeyId)
		return { deleted }
	}),
})

import { createHostInput, hostIdInput } from "@open-mcc/contracts"
import { protectedProcedure, requireCapability, router } from "../trpc"

export const hostRouter = router({
	list: protectedProcedure.query(({ ctx }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return ctx.hostController.list(ctx.actor)
	}),

	enroll: protectedProcedure.input(createHostInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "host.enroll")
		return ctx.hostController.enroll(ctx.actor, input)
	}),

	provision: protectedProcedure.input(hostIdInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "host.enroll")
		return ctx.hostController.provision(ctx.actor, input.hostId)
	}),

	remove: protectedProcedure.input(hostIdInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "host.enroll")
		return ctx.hostController.remove(ctx.actor, input.hostId)
	}),
})

import { protectedProcedure, requireCapability, router } from "../trpc"

export const selfHostRouter = router({
	offer: protectedProcedure.query(async ({ ctx }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return (await ctx.selfHostController.offer(ctx.actor)) ?? null
	}),

	adopt: protectedProcedure.mutation(({ ctx }) => {
		requireCapability(ctx.actor.role, "host.enroll")
		return ctx.selfHostController.adopt(ctx.actor)
	}),
})

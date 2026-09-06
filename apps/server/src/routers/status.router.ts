import { statusEventsInput, statusSummaryInput } from "@open-mcc/contracts"
import { protectedProcedure, requireCapability, router } from "../trpc"

export const statusRouter = router({
	summary: protectedProcedure.input(statusSummaryInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return ctx.statusController.summary(ctx.actor, input.range)
	}),

	events: protectedProcedure.input(statusEventsInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return ctx.statusController.events(ctx.actor, input.range, input.limit)
	}),
})

import { auditListInput } from "@open-mcc/contracts"
import { protectedProcedure, requireCapability, router } from "../trpc"

export const auditRouter = router({
	list: protectedProcedure.input(auditListInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "audit.read")
		return ctx.auditController.list(ctx.actor, input)
	}),
})

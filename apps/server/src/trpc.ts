import { type Capability, can, type Role } from "@open-mcc/contracts"
import { initTRPC, TRPCError } from "@trpc/server"
import { ZodError } from "zod"
import type { RequestContext } from "./context"
import { mapKnownError } from "./errors"

const GENERIC_INTERNAL_MESSAGE = "Internal server error"

const t = initTRPC.context<RequestContext>().create({
	errorFormatter: ({ shape, error }) => {
		const cause = error.cause
		const known = cause instanceof Error ? mapKnownError(cause) : null
		const data = {
			code: known?.code ?? shape.data.code,
			httpStatus: known?.httpStatus ?? shape.data.httpStatus,
			...(known && { errorCode: known.errorCode }),
			...(shape.data.path !== undefined && { path: shape.data.path }),
		}
		if (known) return { ...shape, message: known.message, data }
		if (cause instanceof ZodError) return { ...shape, data }
		if (shape.data.code === "INTERNAL_SERVER_ERROR") {
			return { ...shape, message: GENERIC_INTERNAL_MESSAGE, data }
		}
		return { ...shape, data }
	},
})

export const router = t.router
export const publicProcedure = t.procedure

export const requireCapability = (role: Role, capability: Capability): void => {
	if (!can(role, capability)) {
		throw new TRPCError({ code: "FORBIDDEN", message: `Requires ${capability}` })
	}
}

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
	if (!ctx.actor) throw new TRPCError({ code: "UNAUTHORIZED" })
	return next({ ctx: { ...ctx, actor: ctx.actor } })
})

import { type Capability, can, type ErrorCode, type Role } from "@open-mcc/contracts"
import { inProcedureSpan } from "@open-mcc/core"
import { initTRPC, TRPCError } from "@trpc/server"
import { defaultErrorMap, ZodError } from "zod"
import type { RequestContext } from "./context"
import { mapKnownError } from "./errors"

const GENERIC_INTERNAL_MESSAGE = "Internal server error"

const INVALID_INPUT_MESSAGE = "Check what you entered and try again."

const sentenceFor = (invalid: ZodError): string =>
	invalid.issues.find(
		(issue) =>
			issue.message !==
			defaultErrorMap(issue, { defaultError: issue.message, data: undefined }).message,
	)?.message ?? INVALID_INPUT_MESSAGE

const fieldsOf = (invalid: ZodError): string[] => [
	...new Set(
		invalid.issues
			.flatMap((issue) =>
				issue.code === "unrecognized_keys"
					? issue.keys.map((key) => [...issue.path, key].join("."))
					: [issue.path.join(".")],
			)
			.filter((field) => field.length > 0),
	),
]

const GENERIC_UNMAPPED: Record<string, { message: string; errorCode: ErrorCode }> = {
	UNAUTHORIZED: { message: "Authentication required", errorCode: "UNAUTHORIZED" },
	FORBIDDEN: {
		message: "You do not have permission to perform this action",
		errorCode: "FORBIDDEN",
	},
}

const t = initTRPC.context<RequestContext>().create({
	errorFormatter: ({ shape, error }) => {
		const cause = error.cause
		const known = cause instanceof Error ? mapKnownError(cause) : null
		const invalid = shape.data.code === "BAD_REQUEST" && cause instanceof ZodError ? cause : null
		const generic = GENERIC_UNMAPPED[shape.data.code]
		const data = {
			code: known?.code ?? shape.data.code,
			httpStatus: known?.httpStatus ?? shape.data.httpStatus,
			...(known && { errorCode: known.errorCode }),
			...(!known && generic && { errorCode: generic.errorCode }),
			...(invalid && { fields: fieldsOf(invalid) }),
			...(shape.data.path !== undefined && { path: shape.data.path }),
		}
		if (known) return { ...shape, message: known.message, data }
		if (invalid) return { ...shape, message: sentenceFor(invalid), data }
		if (generic) return { ...shape, message: generic.message, data }
		return { ...shape, message: GENERIC_INTERNAL_MESSAGE, data }
	},
})

export const router = t.router

const tracedProcedure = t.procedure.use(
	async ({ path, type, next }) => await inProcedureSpan(type, path, next),
)

export const publicProcedure = tracedProcedure

export const requireCapability = (role: Role, capability: Capability): void => {
	if (!can(role, capability)) {
		throw new TRPCError({ code: "FORBIDDEN", message: `Requires ${capability}` })
	}
}

export const protectedProcedure = tracedProcedure.use(({ ctx, next }) => {
	if (!ctx.actor) throw new TRPCError({ code: "UNAUTHORIZED" })
	return next({ ctx: { ...ctx, actor: ctx.actor } })
})

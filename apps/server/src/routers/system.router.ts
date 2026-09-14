import { conditionFor, releaseNotesFor, updateStatusFor } from "@open-mcc/core"
import { protectedProcedure, requireCapability, router } from "../trpc"

export const systemRouter = router({
	status: protectedProcedure.query(async ({ ctx }) => {
		const worker = await ctx.processIdentities.find("worker")
		const server = { build: ctx.build, schemaVersion: ctx.schemaVersion }
		return {
			condition: conditionFor(
				server,
				worker
					? {
							role: "worker" as const,
							version: worker.version,
							commit: worker.commit,
							schemaVersion: worker.schemaVersion,
							seenAt: worker.seenAt,
						}
					: undefined,
			),
			server: { ...ctx.build, schemaVersion: ctx.schemaVersion },
			worker: worker
				? {
						version: worker.version,
						commit: worker.commit,
						schemaVersion: worker.schemaVersion,
						seenAt: worker.seenAt,
					}
				: null,
		}
	}),

	updateStatus: protectedProcedure.query(async ({ ctx }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return updateStatusFor(ctx.build, await ctx.updateStates.find())
	}),

	releaseNotes: protectedProcedure.query(async ({ ctx }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return releaseNotesFor(ctx.build, await ctx.updateStates.find())
	}),
})

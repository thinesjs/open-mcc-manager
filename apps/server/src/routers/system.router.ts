import type { SignInOptions, SystemStatus } from "@open-mcc/contracts"
import { conditionFor, releaseNotesFor, updateStatusFor } from "@open-mcc/core"
import { anyUserExists } from "../security/registration-gate"
import { protectedProcedure, publicProcedure, router } from "../trpc"

export const systemRouter = router({
	signInOptions: publicProcedure.query(
		async ({ ctx }): Promise<SignInOptions> => ({
			singleSignOn: ctx.singleSignOn,
			registrationOpen: !(await anyUserExists(ctx.db)),
		}),
	),

	status: protectedProcedure.query(async ({ ctx }): Promise<SystemStatus> => {
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
						seenAt: worker.seenAt.toISOString(),
					}
				: null,
		}
	}),

	updateStatus: protectedProcedure.query(async ({ ctx }) =>
		updateStatusFor(ctx.build, await ctx.updateStates.find()),
	),

	releaseNotes: protectedProcedure.query(async ({ ctx }) =>
		releaseNotesFor(ctx.build, await ctx.updateStates.find()),
	),
})

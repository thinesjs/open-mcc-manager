import type { Executor, ProcessIdentityRow } from "@open-mcc/db"
import type { ProcessRole } from "./fleet-status"

export const HEARTBEAT_MS = 60_000

export type IdentityValues = {
	role: ProcessRole
	version: string
	commit: string
	schemaVersion: string
}

export const createProcessIdentityRepository = (db: Executor) => ({
	announce: async (values: IdentityValues, at: Date): Promise<void> => {
		await db
			.insertInto("processIdentity")
			.values({ ...values, startedAt: at, seenAt: at })
			.onConflict((conflict) =>
				conflict.column("role").doUpdateSet({
					version: values.version,
					commit: values.commit,
					schemaVersion: values.schemaVersion,
					startedAt: at,
					seenAt: at,
				}),
			)
			.execute()
	},

	heartbeat: async (role: ProcessRole, at: Date): Promise<void> => {
		await db.updateTable("processIdentity").set({ seenAt: at }).where("role", "=", role).execute()
	},

	find: async (role: ProcessRole): Promise<ProcessIdentityRow | undefined> =>
		db.selectFrom("processIdentity").selectAll().where("role", "=", role).executeTakeFirst(),
})

export type ProcessIdentityRepository = ReturnType<typeof createProcessIdentityRepository>

export type HeartbeatHandle = { stop: () => void }

export const startHeartbeat = (
	repository: Pick<ProcessIdentityRepository, "heartbeat">,
	role: ProcessRole,
	now: () => Date = () => new Date(),
	intervalMs: number = HEARTBEAT_MS,
): HeartbeatHandle => {
	const timer = setInterval(() => {
		void repository.heartbeat(role, now()).catch(() => undefined)
	}, intervalMs)
	timer.unref?.()
	return { stop: () => clearInterval(timer) }
}

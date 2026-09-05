import type { Executor, InstanceCommandRow } from "@open-mcc/db"
import { nanoid } from "nanoid"
import type { OrgScope } from "../host/host.repository"

export type ScheduledCommandValues = {
	instanceId: string
	name: string
	command: string
	daysOfWeek: string
	minuteOfDay: number
	timezone: string
	enabled: boolean
}

export const createCommandRepository = (db: Executor) => ({
	upsert: async (scope: OrgScope, values: ScheduledCommandValues): Promise<InstanceCommandRow> => {
		const row = await db
			.insertInto("instanceCommand")
			.values({ ...values, id: nanoid(), organizationId: scope.organizationId })
			.onConflict((conflict) =>
				conflict.columns(["organizationId", "instanceId", "name"]).doUpdateSet({
					command: values.command,
					daysOfWeek: values.daysOfWeek,
					minuteOfDay: values.minuteOfDay,
					timezone: values.timezone,
					enabled: values.enabled,
					lastRunAt: null,
					lastRunError: null,
				}),
			)
			.returningAll()
			.executeTakeFirst()
		if (!row) throw new Error("Scheduled command upsert returned no row")
		return row
	},

	listForInstance: async (scope: OrgScope, instanceId: string): Promise<InstanceCommandRow[]> =>
		db
			.selectFrom("instanceCommand")
			.selectAll()
			.where("instanceId", "=", instanceId)
			.where("organizationId", "=", scope.organizationId)
			.orderBy("minuteOfDay", "asc")
			.execute(),

	listEnabledAcrossOrganizations: async (): Promise<InstanceCommandRow[]> =>
		db.selectFrom("instanceCommand").selectAll().where("enabled", "=", true).execute(),

	deleteReturning: async (scope: OrgScope, id: string): Promise<InstanceCommandRow | undefined> =>
		db
			.deleteFrom("instanceCommand")
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.returningAll()
			.executeTakeFirst(),

	delete: async (scope: OrgScope, id: string): Promise<boolean> => {
		const result = await db
			.deleteFrom("instanceCommand")
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.executeTakeFirst()
		return (result.numDeletedRows ?? 0n) > 0n
	},

	claimRun: async (id: string, ranAt: Date, notRunSince: Date): Promise<boolean> => {
		const row = await db
			.updateTable("instanceCommand")
			.set({ lastRunAt: ranAt, lastRunError: null })
			.where("id", "=", id)
			.where((eb) => eb.or([eb("lastRunAt", "is", null), eb("lastRunAt", "<", notRunSince)]))
			.returning("id")
			.executeTakeFirst()
		return row !== undefined
	},

	recordRun: async (id: string, ranAt: Date, error: string | null): Promise<void> => {
		await db
			.updateTable("instanceCommand")
			.set({ lastRunAt: ranAt, lastRunError: error })
			.where("id", "=", id)
			.execute()
	},
})

export type CommandRepository = ReturnType<typeof createCommandRepository>

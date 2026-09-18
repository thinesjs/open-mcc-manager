import type { Executor, InstanceScheduleRow } from "@open-mcc/db"
import { nanoid } from "nanoid"
import type { OrgScope } from "../host/host.repository"
import { InternalError } from "../lib/errors"

export type SleepWindowValues = {
	instanceId: string
	daysOfWeek: string
	stopMinuteOfDay: number
	startMinuteOfDay: number
	timezone: string
	enabled: boolean
}

export const createScheduleRepository = (db: Executor) => ({
	upsert: async (scope: OrgScope, values: SleepWindowValues): Promise<InstanceScheduleRow> => {
		const row = await db
			.insertInto("instanceSchedule")
			.values({ ...values, id: nanoid(), organizationId: scope.organizationId })
			.onConflict((conflict) =>
				conflict.columns(["organizationId", "instanceId"]).doUpdateSet({
					daysOfWeek: values.daysOfWeek,
					stopMinuteOfDay: values.stopMinuteOfDay,
					startMinuteOfDay: values.startMinuteOfDay,
					timezone: values.timezone,
					enabled: values.enabled,
				}),
			)
			.returningAll()
			.executeTakeFirst()
		if (!row) throw new InternalError("Instance schedule upsert returned no row")
		return row
	},

	findByInstance: async (
		scope: OrgScope,
		instanceId: string,
	): Promise<InstanceScheduleRow | undefined> =>
		db
			.selectFrom("instanceSchedule")
			.selectAll()
			.where("instanceId", "=", instanceId)
			.where("organizationId", "=", scope.organizationId)
			.executeTakeFirst(),

	list: async (scope: OrgScope): Promise<InstanceScheduleRow[]> =>
		db
			.selectFrom("instanceSchedule")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.orderBy("createdAt", "desc")
			.execute(),

	delete: async (scope: OrgScope, instanceId: string): Promise<boolean> => {
		const result = await db
			.deleteFrom("instanceSchedule")
			.where("instanceId", "=", instanceId)
			.where("organizationId", "=", scope.organizationId)
			.executeTakeFirst()
		return (result.numDeletedRows ?? 0n) > 0n
	},
})

export type ScheduleRepository = ReturnType<typeof createScheduleRepository>

import type { HostStatus, InstancePublic, InstanceStatus } from "@open-mcc/contracts"

export type FleetInstance = Pick<InstancePublic, "id" | "name" | "status">

export type FleetCount<T extends string> = {
	status: T
	count: number
}

export const countByStatus = <T extends string>(
	statuses: readonly T[],
	rows: readonly { status: T }[],
): FleetCount<T>[] =>
	statuses.map((status) => ({
		status,
		count: rows.filter((row) => row.status === status).length,
	}))

export const INSTANCE_STATUS_ORDER: readonly InstanceStatus[] = [
	"running",
	"stopped",
	"needs_auth",
	"error",
	"created",
]

export const HOST_STATUS_ORDER: readonly HostStatus[] = [
	"ready",
	"provisioning",
	"pending",
	"unreachable",
	"error",
]

export const ATTENTION_ORDER: readonly InstanceStatus[] = ["error", "needs_auth"]

export const instancesNeedingAttention = <T extends FleetInstance>(instances: readonly T[]): T[] =>
	instances
		.filter((instance) => ATTENTION_ORDER.includes(instance.status))
		.sort(
			(left, right) =>
				ATTENTION_ORDER.indexOf(left.status) - ATTENTION_ORDER.indexOf(right.status) ||
				left.name.localeCompare(right.name),
		)

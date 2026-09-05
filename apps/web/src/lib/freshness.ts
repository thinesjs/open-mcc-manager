import type { HostStatus, InstanceStatus } from "@open-mcc/contracts"

export const TRANSIENT_POLL_MS = 4_000

export const SETTLED_POLL_MS = 30_000

export const TRANSIENT_HOST_STATUSES: readonly HostStatus[] = ["pending", "provisioning"]

export const TRANSIENT_INSTANCE_STATUSES: readonly InstanceStatus[] = ["created", "needs_auth"]

export const pollIntervalFor = (
	rows: readonly { status: string }[] | undefined,
	transient: readonly string[],
): number => {
	if (!rows) return SETTLED_POLL_MS
	const moving = rows.some((row) => transient.includes(row.status))
	return moving ? TRANSIENT_POLL_MS : SETTLED_POLL_MS
}

import type { OrgScope } from "../host/host.repository"
import { DEADLETTER_RETENTION_SECONDS } from "../job/queue-setup"
import type { RetentionBoundaries } from "./notification.repository"

export const NOTIFICATION_RETENTION_DAYS = 90

export const TEST_WINDOW_MS = 60 * 1000

export const TESTS_PER_WINDOW = 3

export const TESTS_PER_WINDOW_PER_ORGANIZATION = 10

export const cutoffFor = (now: Date, days: number = NOTIFICATION_RETENTION_DAYS): Date =>
	new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

export const DEADLETTER_RETENTION_DAYS = DEADLETTER_RETENTION_SECONDS / (24 * 60 * 60)

export const boundariesFor = (
	now: Date,
	retentionDays: number = NOTIFICATION_RETENTION_DAYS,
): RetentionBoundaries => ({
	createdBefore: cutoffFor(now, retentionDays),
	settledBefore: cutoffFor(now, DEADLETTER_RETENTION_DAYS),
})

export type CleanupDeps = {
	readonly organizationIds: () => Promise<readonly string[]>
	readonly deleteSettledBefore: (
		scope: OrgScope,
		boundaries: RetentionBoundaries,
	) => Promise<number>
	readonly now: () => Date
	readonly retentionDays?: number
}

export const createCleanupHandler = (deps: CleanupDeps) => async (): Promise<number> => {
	const boundaries = boundariesFor(deps.now(), deps.retentionDays)
	const removed: number[] = []
	for (const organizationId of await deps.organizationIds()) {
		removed.push(await deps.deleteSettledBefore({ organizationId }, boundaries))
	}
	return removed.reduce((total, count) => total + count, 0)
}

export const throttleExceeded = (recent: number, limit: number = TESTS_PER_WINDOW): boolean =>
	recent >= limit

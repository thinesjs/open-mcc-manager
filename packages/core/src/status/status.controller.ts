import type { Db } from "@open-mcc/db"
import { nanoid } from "nanoid"
import type { OrgScope } from "../host/host.repository"
import { nextReachability, type ReachabilityCurrent, UNOBSERVED } from "./reachability"
import { createStatusRepository, type StatusRepository } from "./status.repository"

export type StatusTransactionBundle = { status: StatusRepository }

export type WithStatusTransaction = <T>(
	fn: (repos: StatusTransactionBundle) => Promise<T>,
) => Promise<T>

export const createStatusControllerTransaction = (db: Db): WithStatusTransaction => {
	const withTransaction: WithStatusTransaction = (fn) =>
		db.transaction().execute((tx) => fn({ status: createStatusRepository(tx) }))
	return withTransaction
}

export type StatusControllerDeps = {
	withTransaction: WithStatusTransaction
	now: () => Date
}

export type HostObservation = {
	hostId: string
	hostName: string
	reached: boolean
}

const HOST_REACHABILITY = "host.reachability" as const

export const createStatusController = (deps: StatusControllerDeps) => ({
	recordHostReachability: async (scope: OrgScope, observation: HostObservation): Promise<void> => {
		const now = deps.now()
		await deps.withTransaction(async ({ status }) => {
			const existing = await status.findCondition(
				scope,
				{ hostId: observation.hostId },
				HOST_REACHABILITY,
			)
			const current: ReachabilityCurrent =
				existing === undefined
					? UNOBSERVED
					: {
							state:
								existing.state === "up" || existing.state === "suspect" || existing.state === "down"
									? existing.state
									: "unknown",
							failureStartedAt: existing.failureStartedAt,
						}

			const decision = nextReachability(current, observation.reached, now)

			if (!decision.changed && existing !== undefined) {
				await status.touchCondition(scope, existing.id, now)
				return
			}

			const subject = { hostId: observation.hostId }
			const incidentId =
				decision.state === "down"
					? (existing?.activeIncidentId ?? nanoid())
					: decision.state === "up"
						? null
						: (existing?.activeIncidentId ?? null)

			const event =
				decision.event === undefined
					? undefined
					: await status.recordEvent(scope, {
							subjectType: "host",
							subjectId: observation.hostId,
							subjectLabel: observation.hostName,
							hostId: observation.hostId,
							instanceId: null,
							kind: decision.event,
							occurredAt: now,
							observedAt: now,
							lastCorroboratedAt: now,
							incidentId,
							primarySource: "host_probe",
							sources: ["host_probe"],
							sourceKey: null,
							detail: {},
						})

			await status.closeOpenInterval(scope, subject, HOST_REACHABILITY, now, event?.id ?? null)
			await status.openInterval(
				scope,
				subject,
				HOST_REACHABILITY,
				decision.state,
				now,
				event?.id ?? null,
			)
			await status.upsertCondition(
				scope,
				subject,
				HOST_REACHABILITY,
				{
					state: decision.state,
					observedAt: now,
					failureStartedAt: decision.failureStartedAt,
					activeIncidentId: decision.state === "up" ? null : incidentId,
					detail: {},
				},
				now,
			)
		})
	},
})

export type StatusController = ReturnType<typeof createStatusController>

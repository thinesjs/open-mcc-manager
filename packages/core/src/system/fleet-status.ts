import type { BuildInfo } from "./build-info"
import { sameBuild } from "./build-info"

export const WORKER_STALE_AFTER_MS = 3 * 60 * 1000

export const PROCESS_ROLES = ["server", "worker"] as const

export type ProcessRole = (typeof PROCESS_ROLES)[number]

export type ProcessRecord = {
	role: ProcessRole
	version: string
	commit: string
	schemaVersion: string
	seenAt: Date
}

export const CONTROL_PLANE_CONDITIONS = [
	"healthy",
	"worker-missing",
	"worker-stale",
	"version-skew",
	"schema-skew",
] as const

export type ControlPlaneCondition = (typeof CONTROL_PLANE_CONDITIONS)[number]

export type ControlPlaneStatus = {
	condition: ControlPlaneCondition
	server: { build: BuildInfo; schemaVersion: string }
	worker: ProcessRecord | undefined
}

export const isStale = (seenAt: Date, now: Date): boolean =>
	now.getTime() - seenAt.getTime() > WORKER_STALE_AFTER_MS

export const conditionFor = (
	server: { build: BuildInfo; schemaVersion: string },
	worker: ProcessRecord | undefined,
	now: Date = new Date(),
): ControlPlaneCondition => {
	if (!worker) return "worker-missing"
	if (isStale(worker.seenAt, now)) return "worker-stale"
	if (!sameBuild(server.build, { version: worker.version, commit: worker.commit })) {
		return "version-skew"
	}
	if (server.schemaVersion !== worker.schemaVersion) return "schema-skew"
	return "healthy"
}

export const CONDITION_EXPLANATION: Record<ControlPlaneCondition, string> = {
	healthy: "The control plane and its worker are running the same build.",
	"worker-missing":
		"No worker has ever reported in. Host teardown and other background work will not run until one does.",
	"worker-stale":
		"The worker has stopped reporting in. Background work is queued but nothing is running it.",
	"version-skew":
		"The worker is running a different build from this control plane. Finish the upgrade so both run the same version.",
	"schema-skew":
		"The worker applied a different database schema from this control plane. Finish the upgrade before relying on background work.",
}

export const needsAttention = (condition: ControlPlaneCondition): boolean => condition !== "healthy"

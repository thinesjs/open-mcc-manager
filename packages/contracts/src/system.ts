import { z } from "zod"

export const CONTROL_PLANE_CONDITIONS = [
	"healthy",
	"worker-missing",
	"worker-stale",
	"version-skew",
	"schema-skew",
] as const

export const controlPlaneCondition = z.enum(CONTROL_PLANE_CONDITIONS)

export type ControlPlaneCondition = z.infer<typeof controlPlaneCondition>

export const buildInfoSchema = z.object({
	version: z.string(),
	commit: z.string(),
})

export type BuildInfoPublic = z.infer<typeof buildInfoSchema>

export const systemStatusSchema = z.object({
	condition: controlPlaneCondition,
	server: buildInfoSchema.extend({ schemaVersion: z.string() }),
	worker: buildInfoSchema.extend({ schemaVersion: z.string(), seenAt: z.date() }).nullable(),
})

export type SystemStatus = z.infer<typeof systemStatusSchema>

export const CONDITION_HEADLINE: Record<ControlPlaneCondition, string> = {
	healthy: "Running",
	"worker-missing": "No worker running",
	"worker-stale": "Worker not responding",
	"version-skew": "Versions do not match",
	"schema-skew": "Database schema does not match",
}

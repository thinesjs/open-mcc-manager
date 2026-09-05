export const HOST_HEALTH = ["online", "degraded", "offline", "unknown"] as const

export type HostHealth = (typeof HOST_HEALTH)[number]

export const HEALTH_POLL_MS = 60_000

export const OFFLINE_AFTER_MS = 3 * HEALTH_POLL_MS

export type HealthInput = {
	status: string
	lastSeenAt: Date | null
	failedUnits: number | null
}

export const healthFor = (host: HealthInput, now: Date = new Date()): HostHealth => {
	if (host.status === "pending" || host.status === "provisioning") return "unknown"
	if (host.status === "unreachable" || host.status === "error") return "offline"
	if (host.lastSeenAt === null) return "unknown"
	if (now.getTime() - host.lastSeenAt.getTime() > OFFLINE_AFTER_MS) return "offline"
	return (host.failedUnits ?? 0) > 0 ? "degraded" : "online"
}

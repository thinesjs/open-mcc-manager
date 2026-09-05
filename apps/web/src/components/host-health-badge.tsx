import { type HostHealth, healthFor } from "@open-mcc/contracts"
import { cn } from "~/lib/utils"

export type HostHealthInput = {
	status: string
	lastSeenAt: string | Date | null
	failedUnits: number | null
}

const TONE: Record<HostHealth, string> = {
	online: "bg-success",
	degraded: "bg-warning",
	offline: "bg-destructive",
	unknown: "bg-muted-foreground/40",
}

const LABEL: Record<HostHealth, string> = {
	online: "Online",
	degraded: "Degraded",
	offline: "Offline",
	unknown: "Not yet reached",
}

export const healthOf = (host: HostHealthInput, now: Date = new Date()): HostHealth =>
	healthFor(
		{
			status: host.status,
			lastSeenAt: host.lastSeenAt === null ? null : new Date(host.lastSeenAt),
			failedUnits: host.failedUnits,
		},
		now,
	)

export const HostHealthBadge = ({ host }: { host: HostHealthInput }) => {
	const health = healthOf(host)
	return (
		<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
			<span className={cn("size-1.5 rounded-full", TONE[health])} aria-hidden />
			{LABEL[health]}
		</span>
	)
}

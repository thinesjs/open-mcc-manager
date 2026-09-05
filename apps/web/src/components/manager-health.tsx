import { useQuery } from "@tanstack/react-query"
import { HeartPulse } from "lucide-react"
import { formatBytes, formatDuration, percentOf } from "~/lib/format-bytes"
import { useTRPC } from "~/lib/trpc"

export const ManagerHealth = () => {
	const trpc = useTRPC()
	const query = useQuery({
		...trpc.instance.managerMetrics.queryOptions(),
		refetchInterval: 15_000,
		retry: false,
	})

	const metrics = query.data
	const heapPercent = metrics ? percentOf(metrics.heapUsedBytes, metrics.heapTotalBytes) : 0

	return (
		<div className="rounded-[var(--radius)] border border-border bg-card p-4">
			<div className="flex items-baseline justify-between">
				<h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
					<HeartPulse className="size-4" />
					Control plane
				</h2>
				<span className="text-xs text-muted-foreground">
					{metrics ? `up ${formatDuration(metrics.uptimeSeconds)}` : "—"}
				</span>
			</div>

			<dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
				<div className="flex items-center gap-1.5 text-xs">
					<dt className="text-muted-foreground">Heap</dt>
					<dd className="font-medium tabular-nums text-foreground">
						{metrics
							? `${formatBytes(metrics.heapUsedBytes)} / ${formatBytes(metrics.heapTotalBytes)}`
							: "—"}
					</dd>
				</div>
				<div className="flex items-center gap-1.5 text-xs">
					<dt className="text-muted-foreground">Resident</dt>
					<dd className="font-medium tabular-nums text-foreground">
						{metrics ? formatBytes(metrics.rssBytes) : "—"}
					</dd>
				</div>
				<div className="flex items-center gap-1.5 text-xs">
					<dt className="text-muted-foreground">Buffers</dt>
					<dd className="font-medium tabular-nums text-foreground">
						{metrics ? formatBytes(metrics.arrayBuffersBytes) : "—"}
					</dd>
				</div>
			</dl>

			<div className="mt-3 h-1.5 overflow-hidden rounded-full bg-accent">
				<div
					className={`h-full w-full origin-left transition-transform duration-[var(--duration-surface)] ease-[var(--ease-settle)] motion-reduce:transition-none ${
						heapPercent >= 90 ? "bg-warning" : "bg-primary"
					}`}
					style={{ transform: `scaleX(${heapPercent / 100})` }}
				/>
			</div>
		</div>
	)
}

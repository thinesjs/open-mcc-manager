import { useQuery } from "@tanstack/react-query"
import { CircleAlert, RefreshCw } from "lucide-react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { LoadingBlock, Spinner } from "~/components/ui/spinner"
import { getErrorMessage } from "~/lib/errors"
import { formatDuration, formatMegabytes, percentOf } from "~/lib/format-bytes"
import { useTRPC } from "~/lib/trpc"

export type HostMetricsPanelProps = {
	hostId: string
	ready: boolean
}

const Meter = ({ label, used, total }: { label: string; used: number; total: number }) => {
	const percent = percentOf(used, total)
	return (
		<div className="space-y-1.5">
			<div className="flex items-baseline justify-between text-sm">
				<span className="text-muted-foreground">{label}</span>
				<span className="tabular-nums text-foreground">
					{formatMegabytes(used)} / {formatMegabytes(total)}
				</span>
			</div>
			<div className="h-1.5 overflow-hidden rounded-full bg-accent">
				<div
					className={`h-full w-full origin-left rounded-full transition-transform duration-[var(--duration-surface)] ease-[var(--ease-settle)] motion-reduce:transition-none ${
						percent >= 90 ? "bg-error" : percent >= 75 ? "bg-warning" : "bg-primary"
					}`}
					style={{ transform: `scaleX(${percent / 100})` }}
				/>
			</div>
		</div>
	)
}

export const HostMetricsPanel = ({ hostId, ready }: HostMetricsPanelProps) => {
	const trpc = useTRPC()
	const query = useQuery({
		...trpc.instance.hostMetrics.queryOptions({ hostId }),
		enabled: ready,
		retry: false,
		staleTime: 30_000,
	})

	const metrics = query.data

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between gap-4">
				<div>
					<CardTitle>Host resources</CardTitle>
					<p className="text-sm text-muted-foreground">
						Load, memory and disk as the host reports them.
					</p>
				</div>
				<Button
					size="sm"
					variant="secondary"
					disabled={query.isFetching || !ready}
					onClick={() => {
						void query.refetch()
					}}
				>
					<RefreshCw className={query.isFetching ? "size-4 animate-spin-quick" : "size-4"} />
					{query.isFetching ? <Spinner label="Reading" /> : "Read now"}
				</Button>
			</CardHeader>

			<CardContent className="space-y-4">
				{query.isError ? (
					<Alert variant="error" icon={<CircleAlert />}>
						{getErrorMessage(query.error)}
					</Alert>
				) : null}

				{query.isFetching && !metrics ? <LoadingBlock label="Reading host resources" /> : null}

				{!metrics && !query.isFetching && !query.isError ? (
					<p className="text-sm text-muted-foreground">
						{ready
							? "Reading opens an SSH session to this host."
							: "Available once this host has been provisioned."}
					</p>
				) : null}

				{metrics ? (
					<>
						<div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
							<div>
								<p className="text-muted-foreground">Load (1m)</p>
								<p className="tabular-nums text-foreground">{metrics.loadAverage1m.toFixed(2)}</p>
							</div>
							<div>
								<p className="text-muted-foreground">Uptime</p>
								<p className="tabular-nums text-foreground">
									{formatDuration(metrics.uptimeSeconds)}
								</p>
							</div>
						</div>
						<Meter label="Memory" used={metrics.memoryUsedMb} total={metrics.memoryTotalMb} />
						<Meter label="Disk" used={metrics.diskUsedMb} total={metrics.diskTotalMb} />
					</>
				) : null}
			</CardContent>
		</Card>
	)
}

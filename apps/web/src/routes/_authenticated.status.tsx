import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Activity, CircleAlert } from "lucide-react"
import { AvailabilityStrip } from "~/components/availability-strip"
import { EmptyState } from "~/components/empty-state"
import { Alert } from "~/components/ui/alert"
import { LoadingBlock } from "~/components/ui/spinner"
import { Tooltip } from "~/components/ui/tooltip"
import { getErrorMessage } from "~/lib/errors"
import { describeStatusEvent } from "~/lib/status-events"
import { useTRPC } from "~/lib/trpc"
import { describeCoverage, describeUptime } from "~/lib/uptime"

export const Route = createFileRoute("/_authenticated/status")({
	component: StatusPage,
})

const REACHABILITY_LABEL: Record<string, string> = {
	up: "Reachable",
	suspect: "Not answering",
	down: "Unreachable",
	unknown: "Not checked yet",
}

function StatusPage() {
	const trpc = useTRPC()
	const summaryQuery = useQuery({
		...trpc.status.summary.queryOptions({ range: "24h" }),
		refetchInterval: 60_000,
	})
	const eventsQuery = useQuery({
		...trpc.status.events.queryOptions({ range: "24h", limit: 50 }),
		refetchInterval: 60_000,
	})

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-lg font-semibold text-foreground">Status</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					How reliably OpenMCC has been able to reach your servers.
				</p>
			</div>

			{summaryQuery.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(summaryQuery.error)}
				</Alert>
			) : null}

			{summaryQuery.isPending ? <LoadingBlock label="Loading status" /> : null}

			{summaryQuery.data ? (
				<section className="space-y-3 rounded-[var(--radius)] border border-border bg-card p-4">
					<div className="flex items-baseline justify-between gap-4">
						<h2 className="text-sm font-semibold text-foreground">Servers</h2>
						<p className="text-sm tabular-nums text-muted-foreground">
							{summaryQuery.data.answering} of {summaryQuery.data.total} answering
						</p>
					</div>

					{summaryQuery.data.hosts.length === 0 ? (
						<p className="text-sm text-muted-foreground">No servers yet.</p>
					) : (
						<ul className="space-y-4">
							{summaryQuery.data.hosts.map((host) => {
								const coverage = describeCoverage(host.availability)
								return (
									<li key={host.hostId} className="space-y-1.5">
										<div className="flex items-baseline justify-between gap-4">
											<span className="text-sm font-medium text-foreground">{host.hostName}</span>
											<span className="text-sm tabular-nums text-foreground">
												{describeUptime(host.availability)}
											</span>
										</div>
										<AvailabilityStrip
											availability={host.availability}
											goodLabel="Reachable"
											badLabel="Unreachable"
										/>
										<div className="flex items-baseline justify-between gap-4">
											<span className="text-xs text-muted-foreground">
												{REACHABILITY_LABEL[host.state] ?? host.state}
											</span>
											{coverage ? (
												<Tooltip content="OpenMCC was not checking for part of this period, so that time counts as neither up nor down.">
													<span className="text-xs text-muted-foreground">{coverage}</span>
												</Tooltip>
											) : null}
										</div>
									</li>
								)
							})}
						</ul>
					)}
				</section>
			) : null}

			<section className="space-y-3">
				<h2 className="text-sm font-semibold text-foreground">Recent events</h2>
				{eventsQuery.isPending ? <LoadingBlock label="Loading events" /> : null}
				{eventsQuery.data && eventsQuery.data.length > 0 ? (
					<ol className="divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border bg-card">
						{eventsQuery.data.map((event) => (
							<li key={event.id} className="flex items-baseline gap-3 px-4 py-2.5">
								<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
									{new Date(event.occurredAt).toLocaleTimeString()}
								</span>
								<span className="text-sm text-foreground">
									{describeStatusEvent(event.kind, event.subjectLabel)}
								</span>
							</li>
						))}
					</ol>
				) : eventsQuery.isPending ? null : (
					<EmptyState
						compact
						icon={Activity}
						title="Nothing to report"
						description="Interruptions appear here as they happen."
					/>
				)}
			</section>
		</div>
	)
}

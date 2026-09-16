import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { CircleAlert } from "lucide-react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { LoadingBlock } from "~/components/ui/spinner"
import { Tooltip } from "~/components/ui/tooltip"
import { UptimeBars } from "~/components/uptime-bars"
import { getErrorMessage } from "~/lib/errors"
import { describeEventCount, describeStatusEvent } from "~/lib/status-events"
import { useTRPC } from "~/lib/trpc"
import { describeCoverage, describeUptime } from "~/lib/uptime"

export type HostReliabilityProps = {
	hostId: string
}

const EVENTS_PER_PAGE = 10

const STATE_LABEL: Record<string, string> = {
	up: "Reachable",
	suspect: "Not answering",
	down: "Unreachable",
	unknown: "Not checked yet",
}

export const HostReliability = ({ hostId }: HostReliabilityProps) => {
	const trpc = useTRPC()
	const summaryQuery = useQuery({
		...trpc.status.summary.queryOptions({ range: "24h" }),
		refetchInterval: 60_000,
	})
	const eventsQuery = useInfiniteQuery({
		...trpc.status.events.infiniteQueryOptions(
			{ range: "24h", limit: EVENTS_PER_PAGE, hostId },
			{ getNextPageParam: (page) => page.nextCursor ?? undefined },
		),
		refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) > 1 ? false : 60_000),
		staleTime: 60_000,
	})

	const summary = summaryQuery.data
	const host = summary?.hosts.find((entry) => entry.hostId === hostId)
	const coverage = host ? describeCoverage(host.availability) : undefined
	const pages = eventsQuery.data?.pages ?? []
	const events = pages.flatMap((page) => page.events)
	const total = pages[pages.length - 1]?.total ?? 0

	return (
		<Card>
			<CardHeader>
				<div>
					<CardTitle>Reliability</CardTitle>
					<p className="text-sm text-muted-foreground">
						How often OpenMCC could reach this server in the last day.
					</p>
				</div>
			</CardHeader>

			<CardContent className="space-y-3">
				{summaryQuery.isPending ? <LoadingBlock label="Loading reliability" /> : null}

				{summary && host ? (
					<div className="space-y-1.5">
						<div className="flex items-baseline justify-between gap-4">
							<span className="text-sm text-muted-foreground">
								{STATE_LABEL[host.state] ?? host.state}
							</span>
							<span className="text-sm tabular-nums text-foreground">
								{describeUptime(host.availability)}
							</span>
						</div>
						<UptimeBars
							buckets={host.buckets}
							bucketSeconds={summary.bucketSeconds}
							subject={host.hostName}
						/>
						<div className="flex items-baseline justify-between gap-4">
							<span className="text-xs text-muted-foreground">
								Last checked {new Date(host.lastCheckedAt).toLocaleTimeString()}
							</span>
							{coverage ? (
								<Tooltip content="OpenMCC was not checking for part of this period, so that time counts as neither up nor down.">
									<span className="text-xs text-muted-foreground">{coverage}</span>
								</Tooltip>
							) : null}
						</div>
					</div>
				) : summaryQuery.isPending ? null : (
					<p className="text-sm text-muted-foreground">Nothing measured yet.</p>
				)}

				{eventsQuery.isError ? (
					<Alert variant="error" icon={<CircleAlert />}>
						{getErrorMessage(eventsQuery.error)}
					</Alert>
				) : null}

				{events.length > 0 ? (
					<div className="space-y-2 border-t border-border pt-3">
						<Tooltip
							content="Everything OpenMCC recorded for this server in the last day."
							render={
								<p className="w-fit cursor-help font-medium text-foreground text-xs underline decoration-dotted underline-offset-4" />
							}
						>
							{describeEventCount(total)}
						</Tooltip>
						<ol className="space-y-1">
							{events.map((event) => (
								<li key={event.id} className="flex items-baseline gap-2.5 text-xs">
									<span className="shrink-0 tabular-nums text-muted-foreground">
										{new Date(event.occurredAt).toLocaleTimeString()}
									</span>
									<span className="text-foreground">
										{describeStatusEvent(event.kind, event.subjectLabel)}
									</span>
								</li>
							))}
						</ol>
						{eventsQuery.hasNextPage && events.length < total ? (
							<Button
								size="xs"
								variant="ghost"
								disabled={eventsQuery.isFetchingNextPage}
								onClick={() => {
									eventsQuery.fetchNextPage()
								}}
							>
								Show more
							</Button>
						) : null}
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}

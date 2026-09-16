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

export type BotReliabilityProps = {
	instanceId: string
}

const EVENTS_PER_PAGE = 8

const CONNECTION_LABEL: Record<string, string> = {
	joined: "On its server",
	interrupted: "Just dropped",
	down: "Off its server",
	never_joined: "Running but never joined",
	unknown: "Not measured yet",
}

export const BotReliability = ({ instanceId }: BotReliabilityProps) => {
	const trpc = useTRPC()
	const summaryQuery = useQuery({
		...trpc.status.summary.queryOptions({ range: "24h" }),
		refetchInterval: 60_000,
	})
	const eventsQuery = useInfiniteQuery({
		...trpc.status.events.infiniteQueryOptions(
			{ range: "24h", limit: EVENTS_PER_PAGE, instanceId },
			{ getNextPageParam: (page) => page.nextCursor ?? undefined },
		),
		refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) > 1 ? false : 60_000),
		staleTime: 60_000,
	})

	const summary = summaryQuery.data
	const bot = summary?.bots.find((entry) => entry.instanceId === instanceId)
	const coverage = bot ? describeCoverage(bot.availability) : undefined
	const pages = eventsQuery.data?.pages ?? []
	const events = pages.flatMap((page) => page.events)
	const total = pages[pages.length - 1]?.total ?? 0

	return (
		<Card>
			<CardHeader>
				<div>
					<CardTitle>Time on its server</CardTitle>
					<p className="text-sm text-muted-foreground">
						How much of the last day this bot spent connected and playing.
					</p>
				</div>
			</CardHeader>

			<CardContent className="space-y-3">
				{summaryQuery.isPending ? <LoadingBlock label="Loading uptime" /> : null}

				{summary && bot ? (
					<div className="space-y-1.5">
						<div className="flex items-baseline justify-between gap-4">
							<span className="text-sm text-muted-foreground">
								{CONNECTION_LABEL[bot.state] ?? "Not measured yet"}
							</span>
							<span className="text-sm tabular-nums text-foreground">
								{describeUptime(bot.availability)}
							</span>
						</div>
						<UptimeBars
							buckets={bot.buckets}
							bucketSeconds={summary.bucketSeconds}
							goodLabel="On its server"
							partialLabel="Mostly on its server"
							badLabel="Off its server"
							subject={bot.instanceName}
						/>
						<div className="flex items-baseline justify-between gap-4">
							<span className="text-xs text-muted-foreground">
								{bot.lastChangeAt ? `Since ${new Date(bot.lastChangeAt).toLocaleTimeString()}` : ""}
							</span>
							{coverage ? (
								<Tooltip content="OpenMCC was not watching this bot for the whole period, so that time counts as neither on nor off.">
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
							content="Everything OpenMCC recorded for this bot in the last day."
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

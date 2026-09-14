import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { LoadingBlock } from "~/components/ui/spinner"
import { Tooltip } from "~/components/ui/tooltip"
import { UptimeBars } from "~/components/uptime-bars"
import { describeStatusEvent } from "~/lib/status-events"
import { useTRPC } from "~/lib/trpc"
import { describeCoverage, describeUptime } from "~/lib/uptime"

export type BotReliabilityProps = {
	instanceId: string
}

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
	const eventsQuery = useQuery({
		...trpc.status.events.queryOptions({ range: "24h", limit: 8, instanceId }),
		refetchInterval: 60_000,
	})

	const summary = summaryQuery.data
	const bot = summary?.bots.find((entry) => entry.instanceId === instanceId)
	const coverage = bot ? describeCoverage(bot.availability) : undefined

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

				{eventsQuery.data && eventsQuery.data.length > 0 ? (
					<ol className="space-y-1 border-t border-border pt-3">
						{eventsQuery.data.map((event) => (
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
				) : null}
			</CardContent>
		</Card>
	)
}

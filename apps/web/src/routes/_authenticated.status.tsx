import { STATUS_RANGES, type StatusRange } from "@open-mcc/contracts"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { CircleAlert } from "lucide-react"
import { useState } from "react"
import { Alert } from "~/components/ui/alert"
import { LoadingBlock } from "~/components/ui/spinner"
import { Tooltip } from "~/components/ui/tooltip"
import { UptimeBars } from "~/components/uptime-bars"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"
import { describeCoverage, describeUptime } from "~/lib/uptime"
import { cn } from "~/lib/utils"

export const Route = createFileRoute("/_authenticated/status")({
	component: StatusPage,
})

const CONNECTION_LABEL: Record<string, string> = {
	joined: "On its server",
	interrupted: "Just dropped",
	down: "Off its server",
	never_joined: "Running but never joined",
	unknown: "Not measured yet",
}

const REACHABILITY_LABEL: Record<string, string> = {
	up: "Reachable",
	suspect: "Not answering",
	down: "Unreachable",
	unknown: "Not checked yet",
}

const RANGE_LABEL: Record<StatusRange, string> = {
	"24h": "24 hours",
	"7d": "7 days",
	"30d": "30 days",
}

function StatusPage() {
	const trpc = useTRPC()
	const [range, setRange] = useState<StatusRange>("24h")
	const summaryQuery = useQuery({
		...trpc.status.summary.queryOptions({ range }),
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
					<div className="flex flex-wrap items-baseline justify-between gap-3">
						<h2 className="text-sm font-semibold text-foreground">Servers</h2>
						<div className="flex items-center gap-3">
							<p className="text-sm tabular-nums text-muted-foreground">
								{summaryQuery.data.answering} of {summaryQuery.data.total} answering
							</p>
							<div className="flex gap-1">
								{STATUS_RANGES.map((option) => (
									<button
										key={option}
										type="button"
										onClick={() => setRange(option)}
										className={cn(
											"rounded-[var(--control-radius)] px-2 py-1 text-xs transition-colors active:scale-[0.97]",
											option === range
												? "bg-accent text-foreground"
												: "text-muted-foreground hover:text-foreground",
										)}
									>
										{RANGE_LABEL[option]}
									</button>
								))}
							</div>
						</div>
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
										<UptimeBars
											buckets={host.buckets}
											bucketSeconds={summaryQuery.data.bucketSeconds}
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

			{summaryQuery.data ? (
				<section className="space-y-3 rounded-[var(--radius)] border border-border bg-card p-4">
					<div className="flex items-baseline justify-between gap-4">
						<h2 className="text-sm font-semibold text-foreground">Bots</h2>
						<p className="text-sm tabular-nums text-muted-foreground">
							{summaryQuery.data.bots.filter((bot) => bot.state === "joined").length} of{" "}
							{summaryQuery.data.bots.length} on their server
						</p>
					</div>

					{summaryQuery.data.bots.length === 0 ? (
						<p className="text-sm text-muted-foreground">No bots yet.</p>
					) : (
						<ul className="space-y-4">
							{summaryQuery.data.bots.map((bot) => {
								const coverage = describeCoverage(bot.availability)
								return (
									<li key={bot.instanceId} className="space-y-1.5">
										<div className="flex items-baseline justify-between gap-4">
											<span className="text-sm font-medium text-foreground">
												{bot.instanceName}
											</span>
											<span className="text-sm tabular-nums text-foreground">
												{describeUptime(bot.availability)}
											</span>
										</div>
										<UptimeBars
											buckets={bot.buckets}
											bucketSeconds={summaryQuery.data.bucketSeconds}
											goodLabel="On its server"
											partialLabel="Mostly on its server"
											badLabel="Off its server"
										/>
										<div className="flex items-baseline justify-between gap-4">
											<span className="text-xs text-muted-foreground">
												{CONNECTION_LABEL[bot.state] ?? "Not measured yet"}
											</span>
											{coverage ? (
												<Tooltip content="OpenMCC has not been watching this bot for the whole period, so that time counts as neither on nor off.">
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
		</div>
	)
}

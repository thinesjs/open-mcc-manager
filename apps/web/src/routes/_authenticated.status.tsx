import type { StatusRange } from "@open-mcc/contracts"
import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { CircleAlert } from "lucide-react"
import { useState, useTransition } from "react"
import { StatusRangePicker } from "~/components/status-range-picker"
import { Alert } from "~/components/ui/alert"
import { Tooltip } from "~/components/ui/tooltip"
import { UptimeBars } from "~/components/uptime-bars"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"
import { describeCoverage, describeUptime } from "~/lib/uptime"

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

function StatusPage() {
	const trpc = useTRPC()
	const [range, setRange] = useState<StatusRange>("24h")
	const [changingRange, startRangeChange] = useTransition()
	const summaryQuery = useSuspenseQuery({
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

			<section className="space-y-3 rounded-[var(--radius)] border border-border bg-card p-4">
				<div className="flex flex-wrap items-baseline justify-between gap-3">
					<h2 className="text-sm font-semibold text-foreground">Servers</h2>
					<div className="flex items-center gap-3">
						<p className="text-sm tabular-nums text-muted-foreground">
							{summaryQuery.data.answering} of {summaryQuery.data.total} answering
						</p>
						<StatusRangePicker
							range={range}
							pending={changingRange}
							onChange={(option) => startRangeChange(() => setRange(option))}
						/>
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
										subject={host.hostName}
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
										<span className="text-sm font-medium text-foreground">{bot.instanceName}</span>
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
										subject={bot.instanceName}
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
		</div>
	)
}

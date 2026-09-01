import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { CircleAlert, TriangleAlert } from "lucide-react"
import { HostStatusBadge } from "~/components/host-status-badge"
import { InstanceStatusBadge } from "~/components/instance-status-badge"
import { Alert } from "~/components/ui/alert"
import { getErrorMessage } from "~/lib/errors"
import {
	countByStatus,
	HOST_STATUS_ORDER,
	INSTANCE_STATUS_ORDER,
	instancesNeedingAttention,
} from "~/lib/fleet"
import { presentHostStatus } from "~/lib/host-status"
import { describeExitCode, presentInstanceStatus } from "~/lib/instance-status"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/overview")({
	component: OverviewPage,
})

function OverviewPage() {
	const trpc = useTRPC()
	const instancesQuery = useQuery(trpc.instance.list.queryOptions())
	const hostsQuery = useQuery(trpc.host.list.queryOptions())

	const instances = instancesQuery.data ?? []
	const hosts = hostsQuery.data ?? []
	const attention = instancesNeedingAttention(instances)
	const error = instancesQuery.error ?? hostsQuery.error

	return (
		<div className="space-y-8">
			<div>
				<h1 className="text-lg font-semibold text-foreground">Overview</h1>
				<p className="text-sm text-muted-foreground">
					Fleet health across every host and instance in this organization.
				</p>
			</div>

			{error ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(error)}
				</Alert>
			) : null}

			<section className="grid gap-4 sm:grid-cols-2">
				<div className="rounded-[var(--radius)] border border-border bg-card p-4">
					<div className="flex items-baseline justify-between">
						<h2 className="text-sm font-semibold text-foreground">Instances</h2>
						<Link to="/instances" className="text-xs text-primary hover:underline">
							View all
						</Link>
					</div>
					<p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
						{instancesQuery.isPending ? "—" : instances.length}
					</p>
					<dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
						{countByStatus(INSTANCE_STATUS_ORDER, instances)
							.filter((entry) => entry.count > 0)
							.map((entry) => (
								<div key={entry.status} className="flex items-center gap-1.5 text-xs">
									<dt className="text-muted-foreground">
										{presentInstanceStatus(entry.status).label}
									</dt>
									<dd className="font-medium tabular-nums text-foreground">{entry.count}</dd>
								</div>
							))}
					</dl>
				</div>

				<div className="rounded-[var(--radius)] border border-border bg-card p-4">
					<div className="flex items-baseline justify-between">
						<h2 className="text-sm font-semibold text-foreground">Hosts</h2>
						<Link to="/hosts" className="text-xs text-primary hover:underline">
							View all
						</Link>
					</div>
					<p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
						{hostsQuery.isPending ? "—" : hosts.length}
					</p>
					<dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
						{countByStatus(HOST_STATUS_ORDER, hosts)
							.filter((entry) => entry.count > 0)
							.map((entry) => (
								<div key={entry.status} className="flex items-center gap-1.5 text-xs">
									<dt className="text-muted-foreground">{presentHostStatus(entry.status).label}</dt>
									<dd className="font-medium tabular-nums text-foreground">{entry.count}</dd>
								</div>
							))}
					</dl>
				</div>
			</section>

			<section className="space-y-3">
				<h2 className="text-sm font-semibold text-foreground">Needs attention</h2>
				{instancesQuery.isPending ? (
					<p className="text-sm text-muted-foreground">Loading fleet…</p>
				) : attention.length === 0 ? (
					<div className="rounded-[var(--radius)] border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
						{instances.length === 0
							? "No instances yet. Create one to start AFK-ing on a server."
							: "Every instance is healthy. Nothing needs your attention."}
					</div>
				) : (
					<div className="divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border bg-card">
						{attention.map((instance) => (
							<Link
								key={instance.id}
								to="/instances/$instanceId"
								params={{ instanceId: instance.id }}
								className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-accent"
							>
								<div className="flex min-w-0 items-center gap-3">
									<TriangleAlert className="size-4 shrink-0 text-muted-foreground" />
									<div className="min-w-0">
										<p className="truncate font-medium text-foreground">{instance.name}</p>
										<p className="truncate text-sm text-muted-foreground">
											{describeExitCode(instance.lastExitCode) ??
												presentInstanceStatus(instance.status).description}
										</p>
									</div>
								</div>
								<InstanceStatusBadge status={instance.status} />
							</Link>
						))}
					</div>
				)}
			</section>

			{hosts.length > 0 ? (
				<section className="space-y-3">
					<h2 className="text-sm font-semibold text-foreground">Hosts</h2>
					<div className="divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border bg-card">
						{hosts.map((host) => (
							<Link
								key={host.id}
								to="/hosts/$hostId"
								params={{ hostId: host.id }}
								className="flex items-center justify-between gap-4 px-4 py-2.5 hover:bg-accent"
							>
								<div className="min-w-0">
									<p className="truncate text-sm font-medium text-foreground">{host.name}</p>
									<p className="truncate text-xs text-muted-foreground">
										{host.username}@{host.hostname}:{host.port}
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-3">
									<span className="text-xs tabular-nums text-muted-foreground">
										{instances.filter((instance) => instance.hostId === host.id).length} instances
									</span>
									<HostStatusBadge status={host.status} />
								</div>
							</Link>
						))}
					</div>
				</section>
			) : null}
		</div>
	)
}

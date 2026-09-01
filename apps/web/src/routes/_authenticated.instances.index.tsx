import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ChevronRight, CircleAlert } from "lucide-react"
import { InstanceStatusBadge } from "~/components/instance-status-badge"
import { Alert } from "~/components/ui/alert"
import { getErrorMessage } from "~/lib/errors"
import { describeExitCode } from "~/lib/instance-status"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/instances/")({
	component: InstanceListPage,
})

function InstanceListPage() {
	const trpc = useTRPC()
	const instancesQuery = useQuery(trpc.instance.list.queryOptions())
	const hostsQuery = useQuery(trpc.host.list.queryOptions())

	const hostNameById = new Map((hostsQuery.data ?? []).map((host) => [host.id, host.name]))

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-lg font-semibold text-foreground">Instances</h1>
				<p className="text-sm text-muted-foreground">
					Every Minecraft Console Client this organization supervises.
				</p>
			</div>

			{instancesQuery.isPending ? (
				<p className="text-sm text-muted-foreground">Loading instances…</p>
			) : null}

			{instancesQuery.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(instancesQuery.error)}
				</Alert>
			) : null}

			{instancesQuery.data && instancesQuery.data.length === 0 ? (
				<div className="rounded-[var(--radius)] border border-dashed border-border p-8 text-center">
					<p className="text-sm font-medium text-foreground">No instances yet</p>
					<p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
						An instance is one Minecraft Console Client running on a host, signed in to one
						Microsoft account. Enroll a host first, then create an instance on it.
					</p>
					<Link
						to="/hosts"
						className="mt-3 inline-block text-sm text-primary underline-offset-4 hover:underline"
					>
						Go to hosts
					</Link>
				</div>
			) : null}

			{instancesQuery.data && instancesQuery.data.length > 0 ? (
				<div className="overflow-hidden rounded-[var(--radius)] border border-border bg-card">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
								<th className="px-4 py-2 font-medium">Instance</th>
								<th className="px-4 py-2 font-medium">Host</th>
								<th className="px-4 py-2 font-medium">Account</th>
								<th className="px-4 py-2 font-medium">Status</th>
								<th className="w-8 px-4 py-2" />
							</tr>
						</thead>
						<tbody className="divide-y divide-border">
							{instancesQuery.data.map((instance) => (
								<tr key={instance.id} className="hover:bg-accent">
									<td className="px-4 py-2.5">
										<Link
											to="/instances/$instanceId"
											params={{ instanceId: instance.id }}
											className="font-medium text-foreground"
										>
											{instance.name}
										</Link>
										{describeExitCode(instance.lastExitCode) ? (
											<p className="text-xs text-muted-foreground">
												{describeExitCode(instance.lastExitCode)}
											</p>
										) : null}
									</td>
									<td className="px-4 py-2.5 text-muted-foreground">
										{hostNameById.get(instance.hostId) ?? "—"}
									</td>
									<td className="px-4 py-2.5 text-muted-foreground">{instance.minecraftAccount}</td>
									<td className="px-4 py-2.5">
										<InstanceStatusBadge status={instance.status} />
									</td>
									<td className="px-4 py-2.5">
										<Link to="/instances/$instanceId" params={{ instanceId: instance.id }}>
											<ChevronRight className="size-4 text-muted-foreground" />
										</Link>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
		</div>
	)
}

import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ChevronRight, CircleAlert, Plus } from "lucide-react"
import { HostStatusBadge } from "~/components/host-status-badge"
import { Alert } from "~/components/ui/alert"
import { buttonVariants } from "~/components/ui/button"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/hosts/")({
	component: HostListPage,
})

function HostListPage() {
	const trpc = useTRPC()
	const hostsQuery = useQuery(trpc.host.list.queryOptions())

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-lg font-semibold text-foreground">Hosts</h1>
				<Link to="/hosts/new" className={buttonVariants({ size: "sm" })}>
					<Plus className="size-4" />
					Enroll host
				</Link>
			</div>

			{hostsQuery.isPending ? (
				<p className="text-sm text-muted-foreground">Loading hosts…</p>
			) : null}

			{hostsQuery.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(hostsQuery.error)}
				</Alert>
			) : null}

			{hostsQuery.data && hostsQuery.data.length === 0 ? (
				<div className="rounded-[var(--radius)] border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
					No hosts enrolled yet.{" "}
					<Link to="/hosts/new" className="text-primary underline-offset-4 hover:underline">
						Enroll your first host
					</Link>
					.
				</div>
			) : null}

			{hostsQuery.data && hostsQuery.data.length > 0 ? (
				<div className="divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border bg-card">
					{hostsQuery.data.map((host) => (
						<Link
							key={host.id}
							to="/hosts/$hostId"
							params={{ hostId: host.id }}
							className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-accent"
						>
							<div className="min-w-0">
								<p className="truncate font-medium text-foreground">{host.name}</p>
								<p className="truncate text-sm text-muted-foreground">
									{host.username}@{host.hostname}:{host.port}
								</p>
							</div>
							<div className="flex shrink-0 items-center gap-3">
								<HostStatusBadge status={host.status} />
								<ChevronRight className="size-4 text-muted-foreground" />
							</div>
						</Link>
					))}
				</div>
			) : null}
		</div>
	)
}

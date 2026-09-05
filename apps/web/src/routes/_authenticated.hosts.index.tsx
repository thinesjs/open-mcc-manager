import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ChevronRight, CircleAlert, Plus, Server } from "lucide-react"
import { useState } from "react"
import { EmptyState } from "~/components/empty-state"
import { EnrollHostSteps } from "~/components/enroll-host-steps"
import { HostStatusBadge } from "~/components/host-status-badge"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Modal } from "~/components/ui/modal"
import { getErrorMessage } from "~/lib/errors"
import { pollIntervalFor, TRANSIENT_HOST_STATUSES } from "~/lib/freshness"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/hosts/")({
	component: HostListPage,
})

function HostListPage() {
	const navigate = useNavigate()
	const [enrolling, setEnrolling] = useState(false)
	const trpc = useTRPC()
	const hostsQuery = useQuery({
		...trpc.host.list.queryOptions(),
		refetchInterval: (query) => pollIntervalFor(query.state.data, TRANSIENT_HOST_STATUSES),
	})

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-lg font-semibold text-foreground">Hosts</h1>
				<Button size="sm" onClick={() => setEnrolling(true)}>
					<Plus className="size-4" />
					Enroll host
				</Button>
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
				<EmptyState
					icon={Server}
					title="No hosts enrolled"
					description="Enroll a VPS to run Minecraft Console Client instances on it. You will need its SSH host key fingerprint."
					action={
						<Button size="sm" onClick={() => setEnrolling(true)}>
							<Plus className="size-4" />
							Enroll host
						</Button>
					}
				/>
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

			<Modal
				open={enrolling}
				title="Enroll a host"
				description="Three steps: pick the key, give the address, verify the host key."
				onClose={() => setEnrolling(false)}
			>
				<EnrollHostSteps
					onEnrolled={(hostId) => {
						setEnrolling(false)
						navigate({ to: "/hosts/$hostId", params: { hostId } })
					}}
				/>
			</Modal>
		</div>
	)
}

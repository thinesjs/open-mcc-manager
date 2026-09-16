import { useQuery, useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ChevronRight, CircleAlert, Plus, Server } from "lucide-react"
import { useState } from "react"
import { EmptyState } from "~/components/empty-state"
import { EnrollHostSteps } from "~/components/enroll-host-steps"
import { HostBadge } from "~/components/host-badge"
import { HostContextMenu } from "~/components/host-context-menu"
import { OsIcon } from "~/components/os-icon"
import { SelfHostCard, shouldOfferSelfHost } from "~/components/self-host-card"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Modal } from "~/components/ui/modal"
import { useViewMode, ViewToggle } from "~/components/view-toggle"
import { getErrorMessage } from "~/lib/errors"
import { pollIntervalFor, TRANSIENT_HOST_STATUSES } from "~/lib/freshness"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/hosts/")({
	component: HostListPage,
})

function HostListPage() {
	const navigate = useNavigate()
	const [enrolling, setEnrolling] = useState(false)
	const [view, setView] = useViewMode("open-mcc.view.hosts")
	const trpc = useTRPC()
	const offerQuery = useQuery(trpc.selfHost.offer.queryOptions())
	const hostsQuery = useSuspenseQuery({
		...trpc.host.list.queryOptions(),
		refetchInterval: (query) => pollIntervalFor(query.state.data, TRANSIENT_HOST_STATUSES),
	})
	const offer = offerQuery.data

	return (
		<div className="space-y-6">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-lg font-semibold text-foreground">Hosts</h1>
					<p className="text-sm text-muted-foreground">
						Every server this organization runs Minecraft Console Client instances on.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<ViewToggle mode={view} onChange={setView} label="Host layout" />
					<Button size="sm" onClick={() => setEnrolling(true)}>
						<Plus className="size-4" />
						Enroll host
					</Button>
				</div>
			</div>

			{hostsQuery.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(hostsQuery.error)}
				</Alert>
			) : null}

			{shouldOfferSelfHost(offer, hostsQuery.data) ? (
				<SelfHostCard
					offer={offer}
					onAdded={(hostId) => navigate({ to: "/hosts/$hostId", params: { hostId } })}
				/>
			) : null}

			{hostsQuery.data.length === 0 ? (
				<EmptyState
					icon={Server}
					title="No hosts enrolled"
					description="Add a Linux server to run your bots on. You will need SSH access to it."
					action={
						<Button size="sm" onClick={() => setEnrolling(true)}>
							<Plus className="size-4" />
							Enroll host
						</Button>
					}
				/>
			) : null}

			{hostsQuery.data.length > 0 ? (
				view === "cards" ? (
					<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
						{hostsQuery.data.map((host) => (
							<HostContextMenu key={host.id} host={host}>
								<Link
									key={host.id}
									to="/hosts/$hostId"
									params={{ hostId: host.id }}
									className="group flex flex-col gap-3 rounded-[var(--radius)] border border-border bg-card p-4 transition-colors hover:border-foreground/16 hover:bg-accent/40"
								>
									<div className="flex items-start justify-between gap-3">
										<div className="flex min-w-0 items-center gap-2">
											<OsIcon
												osId={host.osId}
												osName={host.osName}
												className="size-4 text-muted-foreground"
											/>
											<p className="truncate font-medium text-foreground">{host.name}</p>
										</div>
										<HostBadge host={host} />
									</div>
									<p className="truncate text-sm text-muted-foreground">
										{host.username}@{host.hostname}:{host.port}
									</p>
									{host.status === "removing" ? (
										<p className="truncate text-xs text-muted-foreground">
											{host.teardownError ? "Could not be cleaned" : "Cleaning the host…"}
										</p>
									) : null}
									{host.osName ? (
										<p className="truncate text-xs text-muted-foreground">{host.osName}</p>
									) : null}
								</Link>
							</HostContextMenu>
						))}
					</div>
				) : (
					<div className="divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border bg-card">
						{hostsQuery.data.map((host) => (
							<HostContextMenu key={host.id} host={host}>
								<Link
									key={host.id}
									to="/hosts/$hostId"
									params={{ hostId: host.id }}
									className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-accent"
								>
									<div className="flex min-w-0 items-center gap-3">
										<OsIcon
											osId={host.osId}
											osName={host.osName}
											className="size-4 text-muted-foreground"
										/>
										<div className="min-w-0">
											<p className="truncate font-medium text-foreground">{host.name}</p>
											<p className="truncate text-sm text-muted-foreground">
												{host.username}@{host.hostname}:{host.port}
											</p>
										</div>
									</div>
									<div className="flex shrink-0 items-center gap-3">
										<HostBadge host={host} />
										<ChevronRight className="size-4 text-muted-foreground" />
									</div>
								</Link>
							</HostContextMenu>
						))}
					</div>
				)
			) : null}

			<Modal
				open={enrolling}
				title="Enroll a host"
				description="Select a key, provide the address, run the setup command, then verify the host key."
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

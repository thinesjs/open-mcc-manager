import { type InstancePublic, minecraftNameOf } from "@open-mcc/contracts"
import type { AppRouter } from "@open-mcc/server"
import { type Query, useSuspenseQueries } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import type { TRPCClientErrorLike } from "@trpc/client"
import type { TRPCQueryKeyWithoutPrefix } from "@trpc/tanstack-react-query"
import { Boxes, ChevronRight, CircleAlert, Plus, Server } from "lucide-react"
import { useState } from "react"
import { CreateInstanceForm } from "~/components/create-instance-form"
import { EmptyState } from "~/components/empty-state"
import { InstanceActionError } from "~/components/instance-action-error"
import { InstanceContextMenu } from "~/components/instance-context-menu"
import { InstanceStatusBadge } from "~/components/instance-status-badge"
import { PlayerAvatar } from "~/components/player-avatar"
import { Alert } from "~/components/ui/alert"
import { Button, buttonVariants } from "~/components/ui/button"
import { Modal } from "~/components/ui/modal"
import { useViewMode, ViewToggle } from "~/components/view-toggle"
import { getErrorMessage, type TRPCErrorLike } from "~/lib/errors"
import { pollIntervalFor, TRANSIENT_INSTANCE_STATUSES } from "~/lib/freshness"
import { describeExitCode } from "~/lib/instance-status"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/instances/")({
	component: InstanceListPage,
})

function InstanceListPage() {
	const navigate = useNavigate()
	const trpc = useTRPC()
	const [view, setView] = useViewMode("open-mcc.view.instances")
	const [refused, setRefused] = useState<{ instanceId: string; error: TRPCErrorLike } | undefined>(
		undefined,
	)
	const [creating, setCreating] = useState(false)
	const [instancesQuery, hostsQuery] = useSuspenseQueries({
		queries: [
			{
				...trpc.instance.list.queryOptions(),
				refetchInterval: (
					query: Query<
						InstancePublic[],
						TRPCClientErrorLike<AppRouter>,
						InstancePublic[],
						TRPCQueryKeyWithoutPrefix
					>,
				) => pollIntervalFor(query.state.data, TRANSIENT_INSTANCE_STATUSES),
			},
			trpc.host.list.queryOptions(),
		],
	})

	const hostNameById = new Map(hostsQuery.data.map((host) => [host.id, host.name]))
	const readyHosts = hostsQuery.data.filter((host) => host.status === "ready")

	return (
		<div className="space-y-6">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-lg font-semibold text-foreground">Instances</h1>
					<p className="text-sm text-muted-foreground">
						Every Minecraft Console Client this organization supervises.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<ViewToggle mode={view} onChange={setView} label="Instance layout" />
					<Button size="sm" disabled={readyHosts.length === 0} onClick={() => setCreating(true)}>
						<Plus className="size-4" />
						New instance
					</Button>
				</div>
			</div>

			{instancesQuery.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(instancesQuery.error)}
				</Alert>
			) : null}

			{refused ? (
				<InstanceActionError
					error={refused.error}
					instanceId={refused.instanceId}
					busy={false}
					onCancelled={() => setRefused(undefined)}
				/>
			) : null}

			{instancesQuery.data.length === 0 ? (
				<EmptyState
					icon={Boxes}
					title="No instances"
					description={
						readyHosts.length === 0
							? "An instance is one Minecraft Console Client running on a host, signed in to one Minecraft account. Enroll and provision a host before creating one."
							: "An instance is one Minecraft Console Client running on a host, signed in to one Minecraft account."
					}
					action={
						readyHosts.length === 0 ? (
							<Link to="/hosts" className={buttonVariants({ size: "sm" })}>
								Go to hosts
							</Link>
						) : (
							<Button size="sm" onClick={() => setCreating(true)}>
								<Plus className="size-4" />
								New instance
							</Button>
						)
					}
				/>
			) : null}

			{instancesQuery.data.length > 0 ? (
				view === "cards" ? (
					<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
						{instancesQuery.data.map((instance) => (
							<InstanceContextMenu
								key={instance.id}
								instance={instance}
								onActionError={(instanceId, error) => setRefused({ instanceId, error })}
							>
								<Link
									to="/instances/$instanceId"
									params={{ instanceId: instance.id }}
									className="flex flex-col gap-3 rounded-[var(--radius)] border border-border bg-card p-4 transition-colors hover:border-foreground/16 hover:bg-accent/40"
								>
									<div className="flex items-start justify-between gap-3">
										<div className="flex min-w-0 items-center gap-2.5">
											<PlayerAvatar username={minecraftNameOf(instance)} fallback={instance.name} />
											<div className="min-w-0">
												<p className="truncate font-medium text-foreground">{instance.name}</p>
												<p className="truncate text-xs text-muted-foreground">
													{minecraftNameOf(instance) ?? instance.minecraftAccount}
												</p>
											</div>
										</div>
										<InstanceStatusBadge status={instance.status} />
									</div>
									<p className="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
										<Server className="size-3.5 shrink-0" aria-label="Host" />
										<span className="truncate">
											{hostNameById.get(instance.hostId) ?? "Unknown host"}
										</span>
									</p>
									{describeExitCode(instance.lastExitCode) ? (
										<p className="truncate text-xs text-muted-foreground">
											{describeExitCode(instance.lastExitCode)}
										</p>
									) : null}
								</Link>
							</InstanceContextMenu>
						))}
					</div>
				) : (
					<div className="overflow-x-auto rounded-[var(--radius)] border border-border bg-card">
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
									<InstanceContextMenu
										key={instance.id}
										instance={instance}
										onActionError={(instanceId, error) => setRefused({ instanceId, error })}
										render={<tr className="hover:bg-accent" />}
									>
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
										<td className="px-4 py-2.5 text-muted-foreground">
											{instance.minecraftAccount}
										</td>
										<td className="px-4 py-2.5">
											<InstanceStatusBadge status={instance.status} />
										</td>
										<td className="px-4 py-2.5">
											<Link to="/instances/$instanceId" params={{ instanceId: instance.id }}>
												<ChevronRight className="size-4 text-muted-foreground" />
											</Link>
										</td>
									</InstanceContextMenu>
								))}
							</tbody>
						</table>
					</div>
				)
			) : null}
			<Modal
				open={creating}
				title="New instance"
				description="One Minecraft Console Client on a provisioned host, signed in to one Minecraft account."
				onClose={() => setCreating(false)}
			>
				<CreateInstanceForm
					onCancel={() => setCreating(false)}
					onCreated={(instanceId) => {
						setCreating(false)
						navigate({ to: "/instances/$instanceId", params: { instanceId } })
					}}
				/>
			</Modal>
		</div>
	)
}

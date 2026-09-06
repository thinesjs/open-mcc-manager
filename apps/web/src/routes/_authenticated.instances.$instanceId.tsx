import { ACCOUNT_TYPE_LABELS, minecraftNameOf, needsInteractiveSignIn } from "@open-mcc/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import {
	ChevronLeft,
	CircleAlert,
	KeyRound,
	Play,
	Radio,
	RotateCcw,
	Square,
	Terminal,
} from "lucide-react"
import { useState } from "react"
import { BotReliability } from "~/components/bot-reliability"
import { ConsoleComposer } from "~/components/console-composer"
import { ConsoleOutput } from "~/components/console-output"
import { EmptyState } from "~/components/empty-state"
import { InstanceSettingsForm } from "~/components/instance-settings-form"
import { InstanceStatusBadge } from "~/components/instance-status-badge"
import { LiveChat } from "~/components/live-chat"
import { LiveEvents } from "~/components/live-events"
import { LiveInventory } from "~/components/live-inventory"
import { PlayerAvatar } from "~/components/player-avatar"
import { ScheduledCommands } from "~/components/scheduled-commands"
import { SleepWindow } from "~/components/sleep-window"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { ConfirmDialog } from "~/components/ui/dialog"
import { Modal } from "~/components/ui/modal"
import { LoadingBlock, Spinner } from "~/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "~/components/ui/tabs"
import { getErrorMessage, type TRPCErrorLike } from "~/lib/errors"
import { describeExitCode, presentInstanceStatus } from "~/lib/instance-status"
import { consoleLines } from "~/lib/minecraft-text"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/instances/$instanceId")({
	component: InstanceDetailPage,
})

function InstanceDetailPage() {
	const { instanceId } = Route.useParams()
	const navigate = useNavigate()
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const [actionError, setActionError] = useState<string | undefined>(undefined)
	const [confirmingRemove, setConfirmingRemove] = useState(false)
	const [editingSettings, setEditingSettings] = useState(false)

	const instanceQuery = useQuery(trpc.instance.get.queryOptions({ instanceId }))
	const hostsQuery = useQuery(trpc.host.list.queryOptions())
	const configQuery = useQuery(trpc.instance.getConfig.queryOptions({ instanceId }))
	const liveChatQuery = useQuery({
		...trpc.instance.readLiveChat.queryOptions({ instanceId }),
		enabled: configQuery.data?.liveControlEnabled === true,
		retry: false,
		refetchInterval: 3000,
	})
	const liveWorldQuery = useQuery({
		...trpc.instance.readLiveWorld.queryOptions({ instanceId }),
		enabled: configQuery.data?.worldDataEnabled === true,
		retry: false,
		refetchInterval: 5000,
	})
	const liveEntitiesQuery = useQuery({
		...trpc.instance.readLiveEntities.queryOptions({ instanceId }),
		enabled: configQuery.data?.entityDataEnabled === true,
		retry: false,
		refetchInterval: 5000,
	})
	const liveInventoryQuery = useQuery({
		...trpc.instance.readLiveInventory.queryOptions({ instanceId }),
		enabled: configQuery.data?.inventoryDataEnabled === true,
		retry: false,
		refetchInterval: 5000,
	})
	const liveEventsQuery = useQuery({
		...trpc.instance.readLiveEvents.queryOptions({ instanceId }),
		enabled: configQuery.data?.liveControlEnabled === true,
		retry: false,
		refetchInterval: 5000,
	})
	const liveStatusQuery = useQuery({
		...trpc.instance.readLiveStatus.queryOptions({ instanceId }),
		enabled: configQuery.data?.liveControlEnabled === true,
		retry: false,
		refetchInterval: 5000,
	})
	const consoleQuery = useQuery({
		...trpc.instance.readConsole.queryOptions({ instanceId, lines: 200 }),
		retry: false,
		refetchInterval: instanceQuery.data?.status === "running" ? 3000 : false,
	})

	const invalidate = async () => {
		await queryClient.invalidateQueries()
	}

	const onError = (error: TRPCErrorLike) => setActionError(getErrorMessage(error))
	const onSuccess = async () => {
		setActionError(undefined)
		await invalidate()
	}

	const startMutation = useMutation(trpc.instance.start.mutationOptions({ onSuccess, onError }))
	const stopMutation = useMutation(trpc.instance.stop.mutationOptions({ onSuccess, onError }))
	const authenticateMutation = useMutation(
		trpc.instance.authenticate.mutationOptions({ onSuccess, onError }),
	)
	const completeMutation = useMutation(
		trpc.instance.completeAuthentication.mutationOptions({
			onSuccess: async (result) => {
				if (result?.authenticated === true) authenticateMutation.reset()
				await onSuccess()
			},
			onError,
		}),
	)
	const restartMutation = useMutation(trpc.instance.restart.mutationOptions({ onSuccess, onError }))
	const cancelAuthMutation = useMutation(
		trpc.instance.cancelAuthentication.mutationOptions({ onSuccess, onError }),
	)
	const removeMutation = useMutation(trpc.instance.remove.mutationOptions({ onError }))

	const instance = instanceQuery.data
	const interactive = instance ? needsInteractiveSignIn(instance.accountType) : false
	const challenge = authenticateMutation.data
	const busy =
		startMutation.isPending ||
		stopMutation.isPending ||
		restartMutation.isPending ||
		cancelAuthMutation.isPending ||
		authenticateMutation.isPending ||
		completeMutation.isPending ||
		removeMutation.isPending

	return (
		<div className="space-y-6">
			<Link
				to="/instances"
				className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
			>
				<ChevronLeft className="size-4" />
				Instances
			</Link>

			{instanceQuery.isPending ? <LoadingBlock label="Loading instance" /> : null}

			{instanceQuery.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(instanceQuery.error)}
				</Alert>
			) : null}

			{instance ? (
				<>
					<div className="flex flex-wrap items-start justify-between gap-4">
						<div>
							<div className="flex items-center gap-3">
								<PlayerAvatar username={minecraftNameOf(instance)} fallback={instance.name} />
								<h1 className="text-lg font-semibold text-foreground">{instance.name}</h1>
								<InstanceStatusBadge status={instance.status} />
							</div>
							<p className="mt-1 text-sm text-muted-foreground">
								{describeExitCode(instance.lastExitCode) ??
									presentInstanceStatus(instance.status).description}
							</p>
						</div>
						<div className="flex flex-wrap gap-2">
							{!interactive ? null : (
								<>
									<Button
										size="sm"
										variant={instance.status === "needs_auth" ? "default" : "secondary"}
										disabled={busy}
										onClick={() => authenticateMutation.mutate({ instanceId })}
									>
										{authenticateMutation.isPending ? (
											<Spinner label="Requesting a code" />
										) : (
											<>
												<KeyRound className="size-4" />
												{instance.status === "needs_auth"
													? "Get a sign-in code"
													: "Re-authenticate"}
											</>
										)}
									</Button>
									{instance.status === "needs_auth" && challenge ? (
										<Button
											size="sm"
											variant="secondary"
											disabled={busy}
											onClick={() => completeMutation.mutate({ instanceId })}
										>
											{completeMutation.isPending ? (
												<Spinner label="Checking" />
											) : (
												"I finished signing in"
											)}
										</Button>
									) : null}
								</>
							)}
							{instance.status === "running" ? (
								<Button
									size="sm"
									variant="secondary"
									disabled={busy}
									onClick={() => stopMutation.mutate({ instanceId })}
								>
									<Square className="size-4" />
									Stop
								</Button>
							) : (
								<Button
									size="sm"
									disabled={busy || instance.status === "needs_auth"}
									onClick={() => startMutation.mutate({ instanceId })}
								>
									<Play className="size-4" />
									Start
								</Button>
							)}
						</div>
					</div>

					{actionError ? (
						<Alert variant="error" icon={<CircleAlert />}>
							{actionError}
						</Alert>
					) : null}

					{completeMutation.data?.authenticated === true ? (
						<Alert variant="success" icon={<KeyRound />}>
							Signed in. This bot can start now.
						</Alert>
					) : null}

					{completeMutation.data?.authenticated === false ? (
						<Alert variant="warning" icon={<CircleAlert />}>
							The client has not signed in yet. Open the link above, enter the code, and choose “I
							finished signing in” once Microsoft says it is done.
						</Alert>
					) : null}

					{challenge ? (
						<Alert variant="info" icon={<KeyRound />}>
							<span className="block">
								Open{" "}
								<a
									href={challenge.verificationUri}
									target="_blank"
									rel="noreferrer"
									className="text-primary underline underline-offset-4"
								>
									{challenge.verificationUri}
								</a>{" "}
								and enter the code{" "}
								<span className="font-mono font-semibold tracking-wider">{challenge.userCode}</span>
								. Then choose “I finished signing in”.
							</span>
						</Alert>
					) : null}

					<Tabs defaultValue="overview">
						<TabsList>
							<TabsTab value="overview">Overview</TabsTab>
							<TabsTab value="live">Live</TabsTab>
							<TabsTab value="console">Console</TabsTab>
							<TabsTab value="schedule">Schedule</TabsTab>
							<TabsTab value="settings">Settings</TabsTab>
							<TabsTab value="danger">Danger zone</TabsTab>
						</TabsList>

						<TabsPanel value="overview">
							<dl className="grid gap-x-8 gap-y-3 rounded-[var(--radius)] border border-border bg-card p-4 sm:grid-cols-2">
								<div>
									<dt className="text-xs uppercase tracking-wider text-muted-foreground">
										Account
									</dt>
									<dd className="text-sm text-foreground">{instance.minecraftAccount}</dd>
									<dd className="text-xs text-muted-foreground">
										{ACCOUNT_TYPE_LABELS[instance.accountType]}
									</dd>
								</div>
								<div>
									<dt className="text-xs uppercase tracking-wider text-muted-foreground">Host</dt>
									<dd className="text-sm text-foreground">
										<Link
											to="/hosts/$hostId"
											params={{ hostId: instance.hostId }}
											className="text-primary underline-offset-4 hover:underline"
										>
											{hostsQuery.data?.find((host) => host.id === instance.hostId)?.name ??
												instance.hostId}
										</Link>
									</dd>
								</div>
								<div>
									<dt className="text-xs uppercase tracking-wider text-muted-foreground">
										Last exit code
									</dt>
									<dd className="text-sm tabular-nums text-foreground">
										{instance.lastExitCode ?? "—"}
									</dd>
								</div>
								<div>
									<dt className="text-xs uppercase tracking-wider text-muted-foreground">
										Created
									</dt>
									<dd className="text-sm text-foreground">
										{new Date(instance.createdAt).toLocaleString()}
									</dd>
								</div>
							</dl>

							<div className="mt-4">
								<BotReliability instanceId={instanceId} />
							</div>
						</TabsPanel>

						<TabsPanel value="live">
							{configQuery.data && !configQuery.data.liveControlEnabled ? (
								<EmptyState
									icon={Radio}
									title="Live view is off"
									description="Turn on live view in Settings to watch this bot's chat, surroundings and inventory."
								/>
							) : null}
							{configQuery.data?.liveControlEnabled ? (
								<section className="space-y-3 rounded-[var(--radius)] border border-border bg-card p-4">
									<div>
										<h2 className="text-sm font-semibold text-foreground">Live state</h2>
										<p className="text-xs text-muted-foreground">What the bot can see right now.</p>
									</div>
									{liveStatusQuery.isPending ? (
										<Spinner label="Reading live state" />
									) : liveStatusQuery.data ? (
										<dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
											<div className="flex justify-between gap-4">
												<dt className="text-sm text-muted-foreground">Signed in as</dt>
												<dd className="text-sm text-foreground">{liveStatusQuery.data.username}</dd>
											</div>
											<div className="flex justify-between gap-4">
												<dt className="text-sm text-muted-foreground">Connected to</dt>
												<dd className="text-sm text-foreground">
													{liveStatusQuery.data.host}:{liveStatusQuery.data.port}
												</dd>
											</div>
											<div className="flex justify-between gap-4">
												<dt className="text-sm text-muted-foreground">Protocol</dt>
												<dd className="text-sm tabular-nums text-foreground">
													{liveStatusQuery.data.protocolVersion}
												</dd>
											</div>
											<div className="flex justify-between gap-4">
												<dt className="text-sm text-muted-foreground">World data</dt>
												<dd className="text-sm text-foreground">
													{liveStatusQuery.data.terrainEnabled ? "Terrain" : "No terrain"}
												</dd>
											</div>
										</dl>
									) : (
										<p className="text-sm text-muted-foreground">
											Not answering yet. The client only opens this once it has joined a server.
										</p>
									)}

									{liveWorldQuery.data ? (
										<dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
											<div className="flex justify-between gap-4">
												<dt className="text-sm text-muted-foreground">Server ticks</dt>
												<dd className="text-sm tabular-nums text-foreground">
													{liveWorldQuery.data.tps === undefined
														? "—"
														: `${liveWorldQuery.data.tps.toFixed(1)} tps`}
												</dd>
											</div>
											<div className="flex justify-between gap-4">
												<dt className="text-sm text-muted-foreground">Dimension</dt>
												<dd className="text-sm text-foreground">
													{liveWorldQuery.data.dimension ?? "—"}
												</dd>
											</div>
											<div className="flex justify-between gap-4">
												<dt className="text-sm text-muted-foreground">Chunks loaded</dt>
												<dd className="text-sm tabular-nums text-foreground">
													{liveWorldQuery.data.loadedChunkCount ?? 0}
													{liveWorldQuery.data.pendingChunkCount
														? ` (${liveWorldQuery.data.pendingChunkCount} pending)`
														: ""}
												</dd>
											</div>
											<div className="flex justify-between gap-4">
												<dt className="text-sm text-muted-foreground">Position</dt>
												<dd className="text-sm tabular-nums text-foreground">
													{liveWorldQuery.data.location
														? `${Math.round(liveWorldQuery.data.location.x ?? 0)}, ${Math.round(liveWorldQuery.data.location.y ?? 0)}, ${Math.round(liveWorldQuery.data.location.z ?? 0)}`
														: "—"}
												</dd>
											</div>
										</dl>
									) : null}

									{liveEntitiesQuery.data ? (
										<div className="space-y-2">
											<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
												Nearby ({liveEntitiesQuery.data.totalTracked} tracked)
											</h3>
											{liveEntitiesQuery.data.entities.length === 0 ? (
												<p className="text-sm text-muted-foreground">Nothing within {32} blocks.</p>
											) : (
												<ul className="grid gap-x-8 gap-y-1 text-xs sm:grid-cols-2">
													{liveEntitiesQuery.data.entities.map((entity) => (
														<li key={entity.id} className="flex justify-between gap-4">
															<span className="text-foreground">{entity.label}</span>
															<span className="tabular-nums text-muted-foreground">
																{entity.distance === undefined
																	? ""
																	: `${entity.distance.toFixed(1)}m`}
															</span>
														</li>
													))}
												</ul>
											)}
										</div>
									) : null}

									{liveInventoryQuery.data ? (
										<div className="space-y-2">
											<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
												Inventory
											</h3>
											<LiveInventory
												inventory={liveInventoryQuery.data}
												instanceId={instanceId}
												canInteract={configQuery.data?.inventoryDataEnabled === true}
											/>
										</div>
									) : null}

									{liveEventsQuery.data && liveEventsQuery.data.events.length > 0 ? (
										<div className="space-y-2">
											<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
												Events
											</h3>
											<LiveEvents events={liveEventsQuery.data.events} />
										</div>
									) : null}

									{liveChatQuery.data && liveChatQuery.data.length > 0 ? (
										<div className="space-y-2">
											<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
												Chat
											</h3>
											<LiveChat entries={liveChatQuery.data} />
										</div>
									) : null}
								</section>
							) : null}
						</TabsPanel>

						<TabsPanel value="console">
							<section className="space-y-3">
								<h2 className="text-sm font-semibold text-foreground">Console</h2>
								{consoleQuery.isError ? (
									<Alert variant="error" icon={<CircleAlert />}>
										{getErrorMessage(consoleQuery.error)}
									</Alert>
								) : consoleQuery.data && consoleQuery.data.output.trim().length > 0 ? (
									<ConsoleOutput lines={consoleLines(consoleQuery.data.output)} />
								) : (
									<EmptyState
										compact
										icon={Terminal}
										title="No console output"
										description="Output appears once the instance has run."
									/>
								)}
								<ConsoleComposer
									instanceId={instanceId}
									running={instance?.status === "running"}
									onSent={async () => {
										await consoleQuery.refetch()
									}}
								/>
							</section>
						</TabsPanel>

						<TabsPanel value="schedule">
							<SleepWindow instanceId={instanceId} />

							<ScheduledCommands instanceId={instanceId} />
						</TabsPanel>

						<TabsPanel value="settings">
							<section className="space-y-3 rounded-[var(--radius)] border border-border bg-card p-4">
								<div className="flex items-start justify-between gap-4">
									<div>
										<h2 className="text-sm font-semibold text-foreground">Settings</h2>
										<p className="text-xs text-muted-foreground">
											What this client connects to, and how it behaves while it is there.
										</p>
									</div>
									<Button
										size="sm"
										variant="secondary"
										disabled={!configQuery.data}
										onClick={() => setEditingSettings(true)}
									>
										Edit
									</Button>
								</div>
								{configQuery.isPending ? (
									<Spinner label="Loading settings" />
								) : !configQuery.data ? (
									<p className="text-sm text-muted-foreground">
										No saved settings for this instance.
									</p>
								) : (
									<dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
										<div className="flex justify-between gap-4">
											<dt className="text-sm text-muted-foreground">Server</dt>
											<dd className="text-sm text-foreground">{configQuery.data.serverAddress}</dd>
										</div>
										<div className="flex justify-between gap-4">
											<dt className="text-sm text-muted-foreground">Rejoin attempts</dt>
											<dd className="text-sm tabular-nums text-foreground">
												{configQuery.data.autoRelogRetries}
											</dd>
										</div>
										<div className="flex justify-between gap-4">
											<dt className="text-sm text-muted-foreground">Wait between attempts</dt>
											<dd className="text-sm tabular-nums text-foreground">{`${configQuery.data.autoRelogDelaySeconds}s`}</dd>
										</div>
										<div className="flex justify-between gap-4">
											<dt className="text-sm text-muted-foreground">Respawn after dying</dt>
											<dd className="text-sm text-foreground">
												{configQuery.data.autoRespawnEnabled ? "On" : "Off"}
											</dd>
										</div>
										<div className="flex justify-between gap-4">
											<dt className="text-sm text-muted-foreground">Anti-AFK</dt>
											<dd className="text-sm text-foreground">
												{configQuery.data.antiAfkEnabled
													? `Every ${configQuery.data.antiAfkIntervalSeconds}s`
													: "Off"}
											</dd>
										</div>
										<div className="flex justify-between gap-4">
											<dt className="text-sm text-muted-foreground">Live control</dt>
											<dd className="text-sm text-foreground">
												{configQuery.data.liveControlEnabled
													? `On, port ${configQuery.data.liveControlPort}`
													: "Off"}
											</dd>
										</div>
										<div className="flex justify-between gap-4">
											<dt className="text-sm text-muted-foreground">World and position</dt>
											<dd className="text-sm text-foreground">
												{configQuery.data.worldDataEnabled ? "Tracked" : "Off"}
											</dd>
										</div>
										<div className="flex justify-between gap-4">
											<dt className="text-sm text-muted-foreground">Inventory</dt>
											<dd className="text-sm text-foreground">
												{configQuery.data.inventoryDataEnabled ? "Tracked" : "Off"}
											</dd>
										</div>
										<div className="flex justify-between gap-4">
											<dt className="text-sm text-muted-foreground">Nearby entities</dt>
											<dd className="text-sm text-foreground">
												{configQuery.data.entityDataEnabled ? "Tracked" : "Off"}
											</dd>
										</div>
									</dl>
								)}
							</section>
						</TabsPanel>

						<TabsPanel value="danger">
							<div className="space-y-4">
								<section className="space-y-3 rounded-[var(--radius)] border border-border bg-card p-4">
									<div>
										<h2 className="text-sm font-semibold text-foreground">Restart</h2>
										<p className="text-xs text-muted-foreground">
											Applies your saved settings. The bot leaves the server for a few seconds.
										</p>
									</div>
									<Button
										size="sm"
										variant="secondary"
										disabled={busy || instance.status !== "running"}
										onClick={() => restartMutation.mutate({ instanceId })}
									>
										{restartMutation.isPending ? (
											<Spinner label="Restarting" />
										) : (
											<>
												<RotateCcw className="size-4" />
												Restart
											</>
										)}
									</Button>
									{instance.status !== "running" ? (
										<p className="text-xs text-muted-foreground">
											Only a running instance can be restarted. Use Start instead.
										</p>
									) : null}
								</section>

								{interactive ? (
									<section className="space-y-3 rounded-[var(--radius)] border border-border bg-card p-4">
										<div>
											<h2 className="text-sm font-semibold text-foreground">
												Cancel a stuck sign-in
											</h2>
											<p className="text-xs text-muted-foreground">
												Ends a sign-in that was started but never finished.
											</p>
										</div>
										<Button
											size="sm"
											variant="secondary"
											disabled={busy}
											onClick={() => cancelAuthMutation.mutate({ instanceId })}
										>
											{cancelAuthMutation.isPending ? (
												<Spinner label="Cancelling" />
											) : (
												"Cancel sign-in"
											)}
										</Button>
									</section>
								) : null}

								<section className="space-y-3 rounded-[var(--radius)] border border-destructive/40 bg-card p-4">
									<div>
										<h2 className="text-sm font-semibold text-foreground">Remove this instance</h2>
										<p className="text-xs text-muted-foreground">
											Deletes this bot and everything saved for it. This cannot be undone.
										</p>
									</div>
									<Button
										variant="destructive-outline"
										size="sm"
										onClick={() => setConfirmingRemove(true)}
										disabled={busy}
									>
										{removeMutation.isPending ? <Spinner label="Removing" /> : "Remove instance"}
									</Button>
								</section>
							</div>
						</TabsPanel>
					</Tabs>
				</>
			) : null}

			{!configQuery.data ? null : (
				<Modal
					open={editingSettings}
					title="Instance settings"
					description="Takes effect the next time the bot starts."
					onClose={() => setEditingSettings(false)}
				>
					<InstanceSettingsForm
						instanceId={instanceId}
						config={configQuery.data}
						onSaved={async () => {
							setEditingSettings(false)
							await configQuery.refetch()
						}}
						onCancel={() => setEditingSettings(false)}
					/>
				</Modal>
			)}

			<ConfirmDialog
				open={confirmingRemove}
				title="Remove instance"
				description={`Deletes ${instance?.name ?? "this bot"} and everything saved for it. This cannot be undone.`}
				confirmLabel="Remove instance"
				destructive
				busy={removeMutation.isPending}
				error={removeMutation.isError ? getErrorMessage(removeMutation.error) : undefined}
				onConfirm={() => {
					removeMutation.mutate(
						{ instanceId },
						{
							onSuccess: async () => {
								setConfirmingRemove(false)
								await queryClient.invalidateQueries()
								navigate({ to: "/instances" })
							},
						},
					)
				}}
				onCancel={() => setConfirmingRemove(false)}
			/>
		</div>
	)
}

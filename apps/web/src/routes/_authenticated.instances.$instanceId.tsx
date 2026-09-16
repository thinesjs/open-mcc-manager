import { ACCOUNT_TYPE_LABELS, minecraftNameOf, needsInteractiveSignIn } from "@open-mcc/contracts"
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ChevronLeft, CircleAlert, KeyRound, Radio, Terminal } from "lucide-react"
import { useState } from "react"
import { BotReliability } from "~/components/bot-reliability"
import { ConsoleComposer } from "~/components/console-composer"
import { ConsoleOutput } from "~/components/console-output"
import { DeviceCode } from "~/components/device-code"
import { EmptyState } from "~/components/empty-state"
import { InstanceBotsTab, InstanceSettingsTab } from "~/components/instance-config-tabs"
import { InstanceControls } from "~/components/instance-controls"
import { InstanceDangerZone } from "~/components/instance-danger-zone"
import { InstanceStatusBadge } from "~/components/instance-status-badge"
import { LiveChat } from "~/components/live-chat"
import { LiveConnection } from "~/components/live-connection"
import { LiveEvents } from "~/components/live-events"
import { LiveInventory } from "~/components/live-inventory"
import { LiveReadouts } from "~/components/live-readouts"
import { PlayerAvatar } from "~/components/player-avatar"
import { ScheduledCommands } from "~/components/scheduled-commands"
import { SleepWindow } from "~/components/sleep-window"
import { Alert } from "~/components/ui/alert"
import { ConfirmDialog } from "~/components/ui/dialog"
import { Tabs, TabsList, TabsPanel, TabsTab } from "~/components/ui/tabs"
import { getErrorMessage, type TRPCErrorLike } from "~/lib/errors"
import { describeExitCode, presentInstanceStatus } from "~/lib/instance-status"
import { liveReading } from "~/lib/live-reading"
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

	const instanceQuery = useSuspenseQuery(trpc.instance.get.queryOptions({ instanceId }))
	const hostsQuery = useQuery(trpc.host.list.queryOptions())
	const configQuery = useQuery(trpc.instance.getConfig.queryOptions({ instanceId }))
	const liveChatQuery = useQuery({
		...trpc.instance.readLiveChat.queryOptions({ instanceId }),
		enabled: configQuery.data?.config.liveControlEnabled === true,
		retry: false,
		refetchInterval: 3000,
	})
	const liveWorldQuery = useQuery({
		...trpc.instance.readLiveWorld.queryOptions({ instanceId }),
		enabled: configQuery.data?.config.worldDataEnabled === true,
		retry: false,
		refetchInterval: 5000,
	})
	const liveEntitiesQuery = useQuery({
		...trpc.instance.readLiveEntities.queryOptions({ instanceId }),
		enabled: configQuery.data?.config.entityDataEnabled === true,
		retry: false,
		refetchInterval: 5000,
	})
	const liveInventoryQuery = useQuery({
		...trpc.instance.readLiveInventory.queryOptions({ instanceId }),
		enabled: configQuery.data?.config.inventoryDataEnabled === true,
		retry: false,
		refetchInterval: 5000,
	})
	const livePlayerStatsQuery = useQuery({
		...trpc.instance.readLivePlayerStats.queryOptions({ instanceId }),
		enabled: configQuery.data?.config.liveControlEnabled === true,
		retry: false,
		refetchInterval: 5000,
	})
	const liveStatusEffectsQuery = useQuery({
		...trpc.instance.readLiveStatusEffects.queryOptions({ instanceId }),
		enabled: configQuery.data?.config.liveControlEnabled === true,
		retry: false,
		refetchInterval: 5000,
	})
	const liveBotsQuery = useQuery({
		...trpc.instance.readLiveBots.queryOptions({ instanceId }),
		enabled: configQuery.data?.config.liveControlEnabled === true,
		retry: false,
		refetchInterval: 5000,
	})
	const livePlayersQuery = useQuery({
		...trpc.instance.readLivePlayers.queryOptions({ instanceId }),
		enabled: configQuery.data?.config.liveControlEnabled === true,
		retry: false,
		refetchInterval: 5000,
	})
	const liveEventsQuery = useQuery({
		...trpc.instance.readLiveEvents.queryOptions({ instanceId }),
		enabled: configQuery.data?.config.liveControlEnabled === true,
		retry: false,
		refetchInterval: 5000,
	})
	const liveStatusQuery = useQuery({
		...trpc.instance.readLiveStatus.queryOptions({ instanceId }),
		enabled: configQuery.data?.config.liveControlEnabled === true,
		retry: false,
		refetchInterval: 5000,
	})
	const consoleQuery = useQuery({
		...trpc.instance.readConsole.queryOptions({ instanceId, lines: 200 }),
		retry: false,
		refetchInterval: instanceQuery.data.status === "running" ? 3000 : false,
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
		trpc.instance.cancelAuthentication.mutationOptions({
			onSuccess: async () => {
				authenticateMutation.reset()
				completeMutation.reset()
				await onSuccess()
			},
			onError,
		}),
	)
	const removeMutation = useMutation(trpc.instance.remove.mutationOptions({ onError }))

	const instance = instanceQuery.data
	const interactive = needsInteractiveSignIn(instance.accountType)
	const challenge = authenticateMutation.data
	const running = instance?.status === "running"
	const config = configQuery.data?.config
	const liveOn = running && config?.liveControlEnabled === true
	const liveStatus = liveReading(liveStatusQuery, liveOn)
	const liveWorld = liveReading(liveWorldQuery, running && config?.worldDataEnabled === true)
	const liveEntities = liveReading(liveEntitiesQuery, running && config?.entityDataEnabled === true)
	const liveInventory = liveReading(
		liveInventoryQuery,
		running && config?.inventoryDataEnabled === true,
	)
	const liveEvents = liveReading(liveEventsQuery, liveOn)
	const liveChat = liveReading(liveChatQuery, liveOn)
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

			{instanceQuery.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(instanceQuery.error)}
				</Alert>
			) : null}

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
				<InstanceControls
					status={instance.status}
					interactive={interactive}
					hasChallenge={challenge !== undefined}
					busy={busy}
					authenticatePending={authenticateMutation.isPending}
					completePending={completeMutation.isPending}
					onAuthenticate={() => authenticateMutation.mutate({ instanceId })}
					onComplete={() => completeMutation.mutate({ instanceId })}
					onStart={() => startMutation.mutate({ instanceId })}
					onStop={() => stopMutation.mutate({ instanceId })}
				/>
			</div>

			{actionError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{actionError}
				</Alert>
			) : null}

			{completeMutation.data?.authenticated === true ? (
				<Alert variant="success" icon={<KeyRound />}>
					Signed in. Start the bot when you're ready.
				</Alert>
			) : null}

			{completeMutation.data?.authenticated === false ? (
				<Alert variant="warning" icon={<CircleAlert />}>
					The client has not signed in yet. Open the link above, enter the code, and choose “I
					finished signing in” once Microsoft says it is done.
				</Alert>
			) : null}

			{challenge ? <DeviceCode challenge={challenge} /> : null}

			<Tabs defaultValue="overview">
				<TabsList>
					<TabsTab value="overview">Overview</TabsTab>
					<TabsTab value="live">Live</TabsTab>
					<TabsTab value="console">Console</TabsTab>
					<TabsTab value="schedule">Schedule</TabsTab>
					<TabsTab value="settings">Settings</TabsTab>
					<TabsTab value="bots">Bots</TabsTab>
					<TabsTab value="danger">Danger zone</TabsTab>
				</TabsList>

				<TabsPanel value="overview">
					<dl className="grid gap-x-8 gap-y-3 rounded-[var(--radius)] border border-border bg-card p-4 sm:grid-cols-2">
						<div>
							<dt className="text-xs uppercase tracking-wider text-muted-foreground">Account</dt>
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
							<dt className="text-xs uppercase tracking-wider text-muted-foreground">Created</dt>
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
					{configQuery.data && !configQuery.data.config.liveControlEnabled ? (
						<EmptyState
							icon={Radio}
							title="Live view is off"
							description="Turn on live view in Settings to watch this bot's chat, surroundings and inventory."
						/>
					) : null}
					{configQuery.data?.config.liveControlEnabled ? (
						<section className="space-y-3 rounded-[var(--radius)] border border-border bg-card p-4">
							<div>
								<h2 className="text-sm font-semibold text-foreground">Live state</h2>
								<p className="text-xs text-muted-foreground">What the bot can see right now.</p>
							</div>
							<LiveConnection
								running={running}
								pending={liveStatusQuery.isPending}
								liveStatus={liveStatus}
							/>

							{liveWorld ? (
								<dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
									<div className="flex justify-between gap-4">
										<dt className="text-sm text-muted-foreground">Server ticks</dt>
										<dd className="text-sm tabular-nums text-foreground">
											{liveWorld.tps === undefined ? "—" : `${liveWorld.tps.toFixed(1)} tps`}
										</dd>
									</div>
									<div className="flex justify-between gap-4">
										<dt className="text-sm text-muted-foreground">Dimension</dt>
										<dd className="text-sm text-foreground">{liveWorld.dimension ?? "—"}</dd>
									</div>
									<div className="flex justify-between gap-4">
										<dt className="text-sm text-muted-foreground">Chunks loaded</dt>
										<dd className="text-sm tabular-nums text-foreground">
											{liveWorld.loadedChunkCount ?? 0}
											{liveWorld.pendingChunkCount
												? ` (${liveWorld.pendingChunkCount} pending)`
												: ""}
										</dd>
									</div>
									<div className="flex justify-between gap-4">
										<dt className="text-sm text-muted-foreground">Position</dt>
										<dd className="text-sm tabular-nums text-foreground">
											{liveWorld.location
												? `${Math.round(liveWorld.location.x ?? 0)}, ${Math.round(liveWorld.location.y ?? 0)}, ${Math.round(liveWorld.location.z ?? 0)}`
												: "—"}
										</dd>
									</div>
								</dl>
							) : null}

							{running ? (
								<LiveReadouts
									stats={liveReading(livePlayerStatsQuery, liveOn)}
									effects={liveReading(liveStatusEffectsQuery, liveOn)}
									bots={liveReading(liveBotsQuery, liveOn)}
									players={liveReading(livePlayersQuery, liveOn)}
								/>
							) : null}

							{liveEntities ? (
								<div className="space-y-2">
									<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
										Nearby ({liveEntities.totalTracked} tracked)
									</h3>
									{liveEntities.entities.length === 0 ? (
										<p className="text-sm text-muted-foreground">Nothing within {32} blocks.</p>
									) : (
										<ul className="grid gap-x-8 gap-y-1 text-xs sm:grid-cols-2">
											{liveEntities.entities.map((entity) => (
												<li key={entity.id} className="flex justify-between gap-4">
													<span className="text-foreground">{entity.label}</span>
													<span className="tabular-nums text-muted-foreground">
														{entity.distance === undefined ? "" : `${entity.distance.toFixed(1)}m`}
													</span>
												</li>
											))}
										</ul>
									)}
								</div>
							) : null}

							{liveInventory ? (
								<div className="space-y-2">
									<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
										Inventory
									</h3>
									<LiveInventory
										inventory={liveInventory}
										instanceId={instanceId}
										canInteract={configQuery.data?.config.inventoryDataEnabled === true}
									/>
								</div>
							) : null}

							{liveEvents && liveEvents.events.length > 0 ? (
								<div className="space-y-2">
									<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
										Events
									</h3>
									<LiveEvents events={liveEvents.events} />
								</div>
							) : null}

							{liveChat && liveChat.length > 0 ? (
								<div className="space-y-2">
									<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
										Chat
									</h3>
									<LiveChat entries={liveChat} />
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
							players={livePlayersQuery.data}
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
					<InstanceSettingsTab
						instanceId={instanceId}
						pending={configQuery.isPending}
						saved={configQuery.data}
						onSaved={async () => (await configQuery.refetch()).data ?? null}
					/>
				</TabsPanel>

				<TabsPanel value="bots">
					<InstanceBotsTab
						instanceId={instanceId}
						pending={configQuery.isPending}
						saved={configQuery.data}
						onSaved={async () => (await configQuery.refetch()).data ?? null}
					/>
				</TabsPanel>

				<TabsPanel value="danger">
					<InstanceDangerZone
						status={instance.status}
						interactive={interactive}
						busy={busy}
						restartPending={restartMutation.isPending}
						cancelAuthPending={cancelAuthMutation.isPending}
						removePending={removeMutation.isPending}
						onRestart={() => restartMutation.mutate({ instanceId })}
						onCancelAuth={() => cancelAuthMutation.mutate({ instanceId })}
						onRemove={() => setConfirmingRemove(true)}
					/>
				</TabsPanel>
			</Tabs>

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

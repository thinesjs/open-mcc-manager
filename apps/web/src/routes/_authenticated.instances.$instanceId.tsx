import { ACCOUNT_TYPE_LABELS, needsInteractiveSignIn } from "@open-mcc/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ChevronLeft, CircleAlert, KeyRound, Play, Square, Terminal } from "lucide-react"
import { useState } from "react"
import { EmptyState } from "~/components/empty-state"
import { InstanceStatusBadge } from "~/components/instance-status-badge"
import { ScheduledCommands } from "~/components/scheduled-commands"
import { SleepWindow } from "~/components/sleep-window"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { ConfirmDialog } from "~/components/ui/dialog"
import { LoadingBlock, Spinner } from "~/components/ui/spinner"
import { getErrorMessage, type TRPCErrorLike } from "~/lib/errors"
import { describeExitCode, presentInstanceStatus } from "~/lib/instance-status"
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

	const instanceQuery = useQuery(trpc.instance.get.queryOptions({ instanceId }))
	const hostsQuery = useQuery(trpc.host.list.queryOptions())
	const consoleQuery = useQuery({
		...trpc.instance.readConsole.queryOptions({ instanceId, lines: 200 }),
		retry: false,
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
		trpc.instance.completeAuthentication.mutationOptions({ onSuccess, onError }),
	)
	const removeMutation = useMutation(trpc.instance.remove.mutationOptions({ onError }))

	const instance = instanceQuery.data
	const interactive = instance ? needsInteractiveSignIn(instance.accountType) : false
	const challenge = authenticateMutation.data
	const busy =
		startMutation.isPending ||
		stopMutation.isPending ||
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
								<h1 className="text-lg font-semibold text-foreground">{instance.name}</h1>
								<InstanceStatusBadge status={instance.status} />
							</div>
							<p className="mt-1 text-sm text-muted-foreground">
								{describeExitCode(instance.lastExitCode) ??
									presentInstanceStatus(instance.status).description}
							</p>
						</div>
						<div className="flex flex-wrap gap-2">
							{!interactive ? null : instance.status === "needs_auth" ? (
								<Button
									size="sm"
									disabled={busy}
									onClick={() => completeMutation.mutate({ instanceId })}
								>
									<KeyRound className="size-4" />I finished signing in
								</Button>
							) : (
								<Button
									size="sm"
									variant="secondary"
									disabled={busy}
									onClick={() => authenticateMutation.mutate({ instanceId })}
								>
									<KeyRound className="size-4" />
									Authenticate
								</Button>
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

					<SleepWindow instanceId={instanceId} />

					<ScheduledCommands instanceId={instanceId} />

					<section className="space-y-3">
						<h2 className="text-sm font-semibold text-foreground">Console</h2>
						{consoleQuery.isError ? (
							<Alert variant="error" icon={<CircleAlert />}>
								{getErrorMessage(consoleQuery.error)}
							</Alert>
						) : consoleQuery.data && consoleQuery.data.output.trim().length > 0 ? (
							<pre className="max-h-96 overflow-auto rounded-[var(--radius)] border border-border bg-card p-4 font-mono text-xs leading-relaxed text-foreground">
								{consoleQuery.data.output}
							</pre>
						) : (
							<EmptyState
								compact
								icon={Terminal}
								title="No console output"
								description="Output appears once the instance has run."
							/>
						)}
					</section>

					<div className="flex gap-3">
						<Button
							variant="destructive-outline"
							onClick={() => setConfirmingRemove(true)}
							disabled={busy}
						>
							{removeMutation.isPending ? <Spinner label="Removing" /> : "Remove instance"}
						</Button>
					</div>
				</>
			) : null}

			<ConfirmDialog
				open={confirmingRemove}
				title="Remove instance"
				description={`Stops ${instance?.name ?? "this instance"} and removes its unit, schedules and data from the host. Its sign-in is discarded. This cannot be undone.`}
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

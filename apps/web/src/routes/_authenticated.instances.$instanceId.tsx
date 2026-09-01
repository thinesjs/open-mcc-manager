import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ChevronLeft, CircleAlert, KeyRound, Play, Square } from "lucide-react"
import { useState } from "react"
import { InstanceStatusBadge } from "~/components/instance-status-badge"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { getErrorMessage, type TRPCErrorLike } from "~/lib/errors"
import { describeExitCode, presentInstanceStatus } from "~/lib/instance-status"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/instances/$instanceId")({
	component: InstanceDetailPage,
})

function InstanceDetailPage() {
	const { instanceId } = Route.useParams()
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const [actionError, setActionError] = useState<string | undefined>(undefined)

	const instanceQuery = useQuery(trpc.instance.get.queryOptions({ instanceId }))
	const consoleQuery = useQuery(trpc.instance.readConsole.queryOptions({ instanceId, lines: 200 }))

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

	const instance = instanceQuery.data
	const challenge = authenticateMutation.data
	const busy =
		startMutation.isPending ||
		stopMutation.isPending ||
		authenticateMutation.isPending ||
		completeMutation.isPending

	return (
		<div className="space-y-6">
			<Link
				to="/instances"
				className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
			>
				<ChevronLeft className="size-4" />
				Instances
			</Link>

			{instanceQuery.isPending ? (
				<p className="text-sm text-muted-foreground">Loading instance…</p>
			) : null}

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
							{instance.status === "needs_auth" ? (
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
						</div>
						<div>
							<dt className="text-xs uppercase tracking-wider text-muted-foreground">Host</dt>
							<dd className="text-sm text-foreground">
								<Link
									to="/hosts/$hostId"
									params={{ hostId: instance.hostId }}
									className="text-primary underline-offset-4 hover:underline"
								>
									{instance.hostId}
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
							<div className="rounded-[var(--radius)] border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
								No console output yet. Output appears once the instance has run.
							</div>
						)}
					</section>
				</>
			) : null}
		</div>
	)
}

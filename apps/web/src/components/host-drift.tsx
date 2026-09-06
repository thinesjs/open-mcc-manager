import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CircleAlert, CircleCheck, CircleHelp, RefreshCw, TriangleAlert } from "lucide-react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { LoadingBlock, Spinner } from "~/components/ui/spinner"
import {
	describeConfigDrift,
	describeStateDrift,
	describeUnitDrift,
	groupConfigDrift,
	remedyForGroup,
	summariseDrift,
} from "~/lib/drift"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"
import { cn } from "~/lib/utils"

export type HostDriftProps = {
	hostId: string
	ready: boolean
}

export const HostDrift = ({ hostId, ready }: HostDriftProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const restartMutation = useMutation(
		trpc.instance.restart.mutationOptions({
			onSuccess: () => queryClient.invalidateQueries(),
		}),
	)
	const instancesQuery = useQuery(trpc.instance.list.queryOptions())
	const query = useQuery({
		...trpc.instance.reconcileHost.queryOptions({ hostId }),
		enabled: ready,
		retry: false,
		staleTime: 30_000,
	})

	const summary = query.data ? summariseDrift(query.data) : undefined
	const nameFor = (instanceId: string): string =>
		instancesQuery.data?.find((instance) => instance.id === instanceId)?.name ?? instanceId

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between gap-4">
				<div>
					<CardTitle>Bot setup check</CardTitle>
					<p className="text-sm text-muted-foreground">
						Checks whether this server and its bots match your saved settings.
					</p>
				</div>
				<Button
					size="sm"
					variant="secondary"
					disabled={query.isFetching || !ready}
					onClick={() => {
						void query.refetch()
					}}
				>
					<RefreshCw className={query.isFetching ? "size-4 animate-spin-quick" : "size-4"} />
					{query.isFetching ? <Spinner label="Checking" /> : "Check now"}
				</Button>
			</CardHeader>

			<CardContent className="space-y-3">
				{query.isError ? (
					<Alert variant="error" icon={<CircleAlert />}>
						{getErrorMessage(query.error)}
					</Alert>
				) : null}

				{query.isFetching && summary === undefined ? (
					<LoadingBlock label="Checking bot setup" />
				) : null}

				{summary === undefined && !query.isFetching && !query.isError ? (
					<p className="text-sm text-muted-foreground">
						{ready
							? "OpenMCC must be able to reach this server."
							: "Available once this host has been provisioned."}
					</p>
				) : null}

				{summary?.verdict === "unknown" ? (
					<Alert variant="warning" icon={<CircleHelp />}>
						<span className="block font-medium">Host unreachable</span>
						<span className="block text-sm">
							Configuration state could not be determined. {summary.reason}
						</span>
					</Alert>
				) : null}

				{summary?.verdict === "converged" ? (
					<Alert variant="success" icon={<CircleCheck />}>
						The server and its bots match your saved setup.
					</Alert>
				) : null}

				{summary?.verdict === "drifted" ? (
					<>
						<Alert variant="warning" icon={<TriangleAlert />}>
							{summary.total} discrepanc{summary.total === 1 ? "y" : "ies"} detected.
						</Alert>
						<ul className="divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border">
							{summary.unitDrift.map((drift) => (
								<li key={`${drift.kind}:${drift.unit}`} className="px-3 py-2 text-sm">
									<span className="font-mono text-xs text-muted-foreground">{drift.unit}</span>
									<span className="block text-foreground">{describeUnitDrift(drift)}</span>
								</li>
							))}
							{summary.stateDrift.map((drift) => (
								<li key={drift.instanceId} className="px-3 py-2 text-sm">
									<span className="font-mono text-xs text-muted-foreground">
										{nameFor(drift.instanceId)}
									</span>
									<span className="block text-foreground">{describeStateDrift(drift)}</span>
								</li>
							))}
							{groupConfigDrift(summary.configDrift).map((group) => (
								<li key={group.instanceId} className="px-3 py-2 text-sm">
									<div className="flex flex-wrap items-baseline justify-between gap-2">
										<Link
											to="/instances/$instanceId"
											params={{ instanceId: group.instanceId }}
											className="font-medium text-foreground underline-offset-4 hover:underline"
										>
											{nameFor(group.instanceId)}
										</Link>
										<span className="text-xs text-muted-foreground">
											{group.entries.length} setting{group.entries.length === 1 ? "" : "s"} differ
											{group.entries.length === 1 ? "s" : ""}
										</span>
									</div>
									<div className="flex flex-wrap items-center gap-2">
										<span
											className={cn(
												"text-xs",
												group.defeatsSafety || group.neverAnswered
													? "text-destructive"
													: "text-muted-foreground",
											)}
										>
											{remedyForGroup(group)}
										</span>
										<Button
											size="sm"
											variant="secondary"
											disabled={restartMutation.isPending}
											onClick={() => restartMutation.mutate({ instanceId: group.instanceId })}
										>
											{restartMutation.isPending ? (
												<Spinner label="Restarting" />
											) : (
												"Restart to fix"
											)}
										</Button>
									</div>
									<ul className="mt-1 space-y-0.5">
										{group.entries.map((drift) => (
											<li key={drift.key} className="text-xs text-muted-foreground">
												<span className="font-mono">{drift.key}</span> —{" "}
												{describeConfigDrift(drift)}
											</li>
										))}
									</ul>
								</li>
							))}
						</ul>
					</>
				) : null}
			</CardContent>
		</Card>
	)
}

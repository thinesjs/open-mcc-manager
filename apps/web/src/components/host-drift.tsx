import { useQuery } from "@tanstack/react-query"
import { CircleAlert, CircleCheck, CircleHelp, RefreshCw, TriangleAlert } from "lucide-react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { describeStateDrift, describeUnitDrift, summariseDrift } from "~/lib/drift"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export type HostDriftProps = {
	hostId: string
	ready: boolean
}

export const HostDrift = ({ hostId, ready }: HostDriftProps) => {
	const trpc = useTRPC()
	const query = useQuery({
		...trpc.instance.reconcileHost.queryOptions({ hostId }),
		enabled: ready,
		retry: false,
		staleTime: 30_000,
	})

	const summary = query.data ? summariseDrift(query.data) : undefined

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between gap-4">
				<div>
					<CardTitle>Configuration drift</CardTitle>
					<p className="text-sm text-muted-foreground">
						Compares installed units and runtime state against the expected configuration.
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
					{query.isFetching ? "Checking…" : "Check now"}
				</Button>
			</CardHeader>

			<CardContent className="space-y-3">
				{query.isError ? (
					<Alert variant="error" icon={<CircleAlert />}>
						{getErrorMessage(query.error)}
					</Alert>
				) : null}

				{summary === undefined && !query.isFetching && !query.isError ? (
					<p className="text-sm text-muted-foreground">
						{ready
							? "Requires an SSH connection to the host."
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
						No drift detected. Host matches the expected configuration.
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
										{drift.instanceId}
									</span>
									<span className="block text-foreground">{describeStateDrift(drift)}</span>
								</li>
							))}
						</ul>
					</>
				) : null}
			</CardContent>
		</Card>
	)
}

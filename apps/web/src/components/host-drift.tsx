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
}

export const HostDrift = ({ hostId }: HostDriftProps) => {
	const trpc = useTRPC()
	const query = useQuery({
		...trpc.instance.reconcileHost.queryOptions({ hostId }),
		enabled: false,
		retry: false,
	})

	const summary = query.data ? summariseDrift(query.data) : undefined

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between gap-4">
				<div>
					<CardTitle>Configuration drift</CardTitle>
					<p className="text-sm text-muted-foreground">
						Compares the units and run state on this host against what the manager defines.
					</p>
				</div>
				<Button
					size="sm"
					variant="secondary"
					disabled={query.isFetching}
					onClick={() => {
						void query.refetch()
					}}
				>
					<RefreshCw className={query.isFetching ? "size-4 animate-spin" : "size-4"} />
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
						Not checked yet. Checking opens an SSH session to this host.
					</p>
				) : null}

				{summary?.verdict === "unknown" ? (
					<Alert variant="warning" icon={<CircleHelp />}>
						<span className="block font-medium">This host could not be reached.</span>
						<span className="block text-sm">
							Its units and state are unknown — not necessarily wrong. {summary.reason}
						</span>
					</Alert>
				) : null}

				{summary?.verdict === "converged" ? (
					<Alert variant="success" icon={<CircleCheck />}>
						Every unit and instance on this host matches what the manager defines.
					</Alert>
				) : null}

				{summary?.verdict === "drifted" ? (
					<>
						<Alert variant="warning" icon={<TriangleAlert />}>
							{summary.total} difference{summary.total === 1 ? "" : "s"} between this host and the
							manager.
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

import { useQuery } from "@tanstack/react-query"
import { CircleAlert, CircleCheck, CircleHelp, RefreshCw, TriangleAlert } from "lucide-react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { LoadingBlock, Spinner } from "~/components/ui/spinner"
import {
	configDriftDefeatsSafety,
	describeConfigDrift,
	describeStateDrift,
	describeUnitDrift,
	summariseDrift,
} from "~/lib/drift"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export type HostDriftProps = {
	hostId: string
	ready: boolean
}

export const HostDrift = ({ hostId, ready }: HostDriftProps) => {
	const trpc = useTRPC()
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
					<CardTitle>Configuration drift</CardTitle>
					<p className="text-sm text-muted-foreground">
						Compares installed units, runtime state and each client's config against what this
						manager expects.
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
					<LoadingBlock label="Checking configuration drift" />
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
										{nameFor(drift.instanceId)}
									</span>
									<span className="block text-foreground">{describeStateDrift(drift)}</span>
								</li>
							))}
							{summary.configDrift.map((drift) => (
								<li key={`${drift.instanceId}:${drift.key}`} className="px-3 py-2 text-sm">
									<span className="font-mono text-xs text-muted-foreground">
										{nameFor(drift.instanceId)} · {drift.key}
									</span>
									<span className="block text-foreground">{describeConfigDrift(drift)}</span>
									{configDriftDefeatsSafety(drift) ? (
										<span className="block text-xs text-destructive">
											This setting is not an operator choice. Re-save the instance settings to
											restore it.
										</span>
									) : null}
								</li>
							))}
						</ul>
					</>
				) : null}
			</CardContent>
		</Card>
	)
}

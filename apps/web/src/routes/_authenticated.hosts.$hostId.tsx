import type { HostStatus } from "@open-mcc/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { CircleAlert } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { HostDrift } from "~/components/host-drift"
import { HostHealthBadge } from "~/components/host-health-badge"
import { HostMetricsPanel } from "~/components/host-metrics"
import { HostStatusBadge } from "~/components/host-status-badge"
import { ProvisionProgress } from "~/components/provision-progress"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { ConfirmDialog } from "~/components/ui/dialog"
import { getErrorMessage } from "~/lib/errors"
import { pollIntervalFor, TRANSIENT_HOST_STATUSES } from "~/lib/freshness"
import { sawProvisioningFinish, stillShowingCompletion } from "~/lib/just-provisioned"
import { useTRPC } from "~/lib/trpc"

export const confinementLabel = (sandboxed: boolean | null): string => {
	if (sandboxed === null) return "Unknown until provisioned"
	return sandboxed ? "Enforced by systemd" : "Not enforced by this host's systemd"
}

export const Route = createFileRoute("/_authenticated/hosts/$hostId")({
	component: HostDetailPage,
})

const formatDate = (value: Date | string | null): string => {
	if (!value) return "Never"
	return new Date(value).toLocaleString()
}

function HostDetailPage() {
	const { hostId } = Route.useParams()
	const trpc = useTRPC()
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [confirmingRemove, setConfirmingRemove] = useState(false)

	const hostsQuery = useQuery({
		...trpc.host.list.queryOptions(),
		refetchInterval: (query) => pollIntervalFor(query.state.data, TRANSIENT_HOST_STATUSES),
	})
	const provisionMutation = useMutation(trpc.host.provision.mutationOptions())
	const removeMutation = useMutation(trpc.host.remove.mutationOptions())

	const host = hostsQuery.data?.find((candidate) => candidate.id === hostId)

	const previousStatus = useRef<HostStatus | undefined>(undefined)
	const [justProvisioned, setJustProvisioned] = useState(false)

	useEffect(() => {
		if (!host) return
		if (sawProvisioningFinish(previousStatus.current, host.status)) setJustProvisioned(true)
		if (!stillShowingCompletion(host.status, true)) setJustProvisioned(false)
		previousStatus.current = host.status
	}, [host])

	const handleProvision = () => {
		provisionMutation.mutate(
			{ hostId },
			{
				onSuccess: () => {
					queryClient.invalidateQueries({ queryKey: trpc.host.list.queryKey() })
				},
			},
		)
	}

	const handleRemove = () => {
		removeMutation.mutate(
			{ hostId },
			{
				onSuccess: () => {
					setConfirmingRemove(false)
					queryClient.invalidateQueries({ queryKey: trpc.host.list.queryKey() })
					navigate({ to: "/hosts" })
				},
			},
		)
	}

	if (hostsQuery.isPending) {
		return <p className="text-sm text-muted-foreground">Loading host…</p>
	}

	if (hostsQuery.isError) {
		return (
			<Alert variant="error" icon={<CircleAlert />}>
				{getErrorMessage(hostsQuery.error)}
			</Alert>
		)
	}

	if (!host) {
		return (
			<Alert variant="error" icon={<CircleAlert />}>
				Host not found.
			</Alert>
		)
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-lg font-semibold text-foreground">{host.name}</h1>
					<p className="text-sm text-muted-foreground">
						{host.username}@{host.hostname}:{host.port}
					</p>
				</div>
				<HostStatusBadge status={host.status} />
			</div>

			{provisionMutation.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(provisionMutation.error)}
				</Alert>
			) : null}
			{removeMutation.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(removeMutation.error)}
				</Alert>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>Host details</CardTitle>
				</CardHeader>
				<CardContent className="grid grid-cols-2 gap-4 text-sm">
					<div>
						<p className="text-muted-foreground">OS release</p>
						<p className="text-foreground">{host.osRelease ?? "Unknown"}</p>
					</div>
					<div>
						<p className="text-muted-foreground">Last seen</p>
						<p className="text-foreground">{formatDate(host.lastSeenAt)}</p>
					</div>
					<div>
						<p className="text-muted-foreground">Host key algorithm</p>
						<p className="text-foreground">{host.hostKeyAlgorithm ?? "Unknown"}</p>
					</div>
					<div>
						<p className="text-muted-foreground">Reachability</p>
						<p className="text-foreground">
							<HostHealthBadge host={host} />
						</p>
					</div>
					<div>
						<p className="text-muted-foreground">Privilege</p>
						<p className="text-foreground">
							{host.mode === "rootless" ? "Without root" : "With root"}
						</p>
					</div>
					<div>
						<p className="text-muted-foreground">Instance confinement</p>
						<p className="text-foreground">{confinementLabel(host.sandboxed)}</p>
					</div>
					<div className="col-span-2">
						<p className="text-muted-foreground">Trusted host key fingerprint</p>
						<p className="break-all font-mono text-foreground">
							{host.hostKeyFingerprint ?? "Not set"}
						</p>
					</div>
					<div className="col-span-2">
						<p className="text-muted-foreground">Trusted by</p>
						<p className="text-foreground">
							{host.hostKeyTrustedByLabel} on {formatDate(host.hostKeyTrustedAt)}
						</p>
					</div>
				</CardContent>
			</Card>

			{host.status === "removing" ? (
				<Card>
					<CardHeader>
						<CardTitle>Removing this host</CardTitle>
						<p className="text-sm text-muted-foreground">
							{host.teardownError
								? "The host could not be cleaned. It stays here until it has been, so nothing is left behind on it."
								: "Stopping its units, removing what was installed, then deleting this record. This continues on the server."}
						</p>
					</CardHeader>
					<CardContent>
						{host.teardownError ? (
							<Alert variant="error" icon={<CircleAlert />}>
								{host.teardownError}
							</Alert>
						) : (
							<p className="text-sm text-muted-foreground">
								Requested {formatDate(host.teardownRequestedAt)}.
							</p>
						)}
					</CardContent>
				</Card>
			) : null}

			{(host.provisioningStep || host.provisioningError) &&
			(host.status === "provisioning" || host.status === "error" || justProvisioned) ? (
				<Card>
					<CardHeader>
						<CardTitle>Provisioning</CardTitle>
						<p className="text-sm text-muted-foreground">
							{justProvisioned
								? "Every step finished. This host can now run instances."
								: host.status === "provisioning"
									? "This continues on the server. You can leave this page and come back."
									: "This run did not finish. Fix the cause on the host, then provision again."}
						</p>
					</CardHeader>
					<CardContent>
						<ProvisionProgress
							step={host.provisioningStep}
							index={host.provisioningStepIndex}
							total={host.provisioningStepTotal}
							failure={host.provisioningError}
							running={host.status === "provisioning"}
							complete={justProvisioned}
							mode={host.mode}
						/>
					</CardContent>
				</Card>
			) : null}

			<HostMetricsPanel hostId={host.id} ready={host.status === "ready"} />

			<HostDrift hostId={host.id} ready={host.status === "ready"} />

			<div className="flex gap-3">
				<Button
					onClick={handleProvision}
					disabled={
						provisionMutation.isPending ||
						host.status === "provisioning" ||
						host.status === "removing"
					}
				>
					{provisionMutation.isPending ? "Provisioning…" : "Provision"}
				</Button>
				<Button
					variant="destructive-outline"
					onClick={() => setConfirmingRemove(true)}
					disabled={
						removeMutation.isPending || host.status === "provisioning" || host.status === "removing"
					}
				>
					{removeMutation.isPending ? "Removing…" : "Remove"}
				</Button>
			</div>

			<ConfirmDialog
				open={confirmingRemove}
				title="Remove host"
				description={`Stops and removes everything this control plane installed on ${host.name}, then deletes its record. The host stays listed until it has been cleaned. Remove its instances first. This cannot be undone.`}
				confirmLabel="Remove host"
				destructive
				busy={removeMutation.isPending}
				error={removeMutation.isError ? getErrorMessage(removeMutation.error) : undefined}
				onConfirm={handleRemove}
				onCancel={() => setConfirmingRemove(false)}
			/>
		</div>
	)
}

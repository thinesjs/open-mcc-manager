import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { CircleAlert } from "lucide-react"
import { HostDrift } from "~/components/host-drift"
import { HostMetricsPanel } from "~/components/host-metrics"
import { HostStatusBadge } from "~/components/host-status-badge"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

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

	const hostsQuery = useQuery(trpc.host.list.queryOptions())
	const provisionMutation = useMutation(trpc.host.provision.mutationOptions())
	const removeMutation = useMutation(trpc.host.remove.mutationOptions())

	const host = hostsQuery.data?.find((candidate) => candidate.id === hostId)

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
		if (!window.confirm("Remove this host? This cannot be undone.")) return
		removeMutation.mutate(
			{ hostId },
			{
				onSuccess: () => {
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
		<div className="max-w-2xl space-y-6">
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

			<HostMetricsPanel hostId={host.id} />

			<HostDrift hostId={host.id} />

			<div className="flex gap-3">
				<Button
					onClick={handleProvision}
					disabled={provisionMutation.isPending || host.status === "provisioning"}
				>
					{provisionMutation.isPending ? "Provisioning…" : "Provision"}
				</Button>
				<Button
					variant="destructive-outline"
					onClick={handleRemove}
					disabled={removeMutation.isPending || host.status === "provisioning"}
				>
					{removeMutation.isPending ? "Removing…" : "Remove"}
				</Button>
			</div>
		</div>
	)
}

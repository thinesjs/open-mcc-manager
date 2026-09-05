import { CONDITION_HEADLINE, type SystemStatus } from "@open-mcc/contracts"
import { useQuery } from "@tanstack/react-query"
import { TriangleAlert } from "lucide-react"
import { Alert } from "~/components/ui/alert"
import { useTRPC } from "~/lib/trpc"

export const EXPLANATION: Record<SystemStatus["condition"], string> = {
	healthy: "",
	"worker-missing":
		"No worker has reported in. Background work such as host teardown is queued but nothing is running it.",
	"worker-stale":
		"The worker has stopped reporting in. Background work is queued but nothing is running it.",
	"version-skew":
		"The worker is running a different build from this control plane. Finish the upgrade so both run the same version.",
	"schema-skew":
		"The worker applied a different database schema. Finish the upgrade before relying on background work.",
}

export const ControlPlaneStatus = () => {
	const trpc = useTRPC()
	const query = useQuery({
		...trpc.system.status.queryOptions(),
		refetchInterval: 60_000,
		retry: false,
	})

	const status = query.data
	if (!status || status.condition === "healthy") return null

	return (
		<Alert variant="warning" icon={<TriangleAlert />}>
			<span className="font-medium">{CONDITION_HEADLINE[status.condition]}.</span>{" "}
			{EXPLANATION[status.condition]}
		</Alert>
	)
}

export const BuildBadge = () => {
	const trpc = useTRPC()
	const query = useQuery({ ...trpc.system.status.queryOptions(), retry: false })
	const server = query.data?.server
	if (!server) return null

	return (
		<p className="px-5 py-2 text-xs text-muted-foreground">
			{server.commit === "unknown" ? server.version : `${server.version} · ${server.commit}`}
		</p>
	)
}

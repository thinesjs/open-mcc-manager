import { CONDITION_HEADLINE, type SystemStatus } from "@open-mcc/contracts"
import { useQuery } from "@tanstack/react-query"
import { CircleArrowUp, TriangleAlert } from "lucide-react"
import { Alert } from "~/components/ui/alert"
import { Tooltip } from "~/components/ui/tooltip"
import { useTRPC } from "~/lib/trpc"
import { DEVELOPMENT_BUILD_TOOLTIP } from "~/lib/update-status"

export const EXPLANATION: Record<SystemStatus["condition"], string> = {
	healthy: "",
	"worker-missing": "Background work is paused. Ask whoever runs this server to restart OpenMCC.",
	"worker-stale": "Background work is paused. Ask whoever runs this server to restart OpenMCC.",
	"version-skew": "The OpenMCC upgrade is incomplete. Finish it before relying on background work.",
	"schema-skew": "The OpenMCC upgrade is incomplete. Finish it before relying on background work.",
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

export type BuildBadgeProps = {
	onOpenUpdate: () => void
}

export const BuildBadge = ({ onOpenUpdate }: BuildBadgeProps) => {
	const trpc = useTRPC()
	const query = useQuery({ ...trpc.system.status.queryOptions(), retry: false })
	const update = useQuery({
		...trpc.system.updateStatus.queryOptions(),
		refetchInterval: 60_000,
		retry: false,
	})
	const server = query.data?.server
	if (!server) return null

	const label =
		server.commit === "unknown" ? server.version : `${server.version} · ${server.commit}`
	const status = update.data

	if (!status || status.kind === "development") {
		return (
			<p className="flex items-center gap-1.5 px-5 py-2 text-xs text-muted-foreground">
				<span>{label}</span>
				{status?.kind === "development" ? (
					<Tooltip content={DEVELOPMENT_BUILD_TOOLTIP}>
						<span className="text-muted-foreground/70">dev</span>
					</Tooltip>
				) : null}
			</p>
		)
	}

	const available = status.kind === "checked" && status.available

	return (
		<button
			type="button"
			onClick={onOpenUpdate}
			className="flex items-center gap-1.5 px-5 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
		>
			<span>{label}</span>
			{available ? (
				<>
					<CircleArrowUp aria-hidden="true" className="size-3.5 text-foreground" />
					<span className="sr-only">Update available</span>
				</>
			) : null}
		</button>
	)
}

import type { HostPublic } from "@open-mcc/contracts"
import { HostHealthBadge, type HostHealthInput } from "~/components/host-health-badge"
import { HostStatusBadge } from "~/components/host-status-badge"

export type HostBadgeProps = {
	host: HostHealthInput & Pick<HostPublic, "status">
}

export const HostBadge = ({ host }: HostBadgeProps) =>
	host.status === "ready" ? (
		<HostHealthBadge host={host} />
	) : (
		<HostStatusBadge status={host.status} />
	)

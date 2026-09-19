import type { HostStatus } from "@open-mcc/contracts"
import { StatusTransition } from "~/components/status-transition"
import { Badge } from "~/components/ui/badge"
import { presentHostStatus } from "~/lib/host-status"

export type HostStatusBadgeProps = {
	status: HostStatus
}

export const HostStatusBadge = ({ status }: HostStatusBadgeProps) => {
	const presentation = presentHostStatus(status)
	return (
		<StatusTransition value={status}>
			<Badge variant={presentation.variant}>{presentation.label}</Badge>
		</StatusTransition>
	)
}

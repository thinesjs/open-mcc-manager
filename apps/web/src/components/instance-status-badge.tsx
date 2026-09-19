import type { InstanceStatus } from "@open-mcc/contracts"
import { StatusTransition } from "~/components/status-transition"
import { Badge } from "~/components/ui/badge"
import { presentInstanceStatus } from "~/lib/instance-status"

export type InstanceStatusBadgeProps = {
	status: InstanceStatus
}

export const InstanceStatusBadge = ({ status }: InstanceStatusBadgeProps) => {
	const presentation = presentInstanceStatus(status)
	return (
		<StatusTransition value={status}>
			<Badge variant={presentation.variant}>{presentation.label}</Badge>
		</StatusTransition>
	)
}

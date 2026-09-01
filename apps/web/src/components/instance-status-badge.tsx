import type { InstanceStatus } from "@open-mcc/contracts"
import { Badge } from "~/components/ui/badge"
import { presentInstanceStatus } from "~/lib/instance-status"

export type InstanceStatusBadgeProps = {
	status: InstanceStatus
}

export const InstanceStatusBadge = ({ status }: InstanceStatusBadgeProps) => {
	const presentation = presentInstanceStatus(status)
	return <Badge variant={presentation.variant}>{presentation.label}</Badge>
}

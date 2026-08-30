import type { HostStatus } from "@open-mcc/contracts"
import { Badge } from "~/components/ui/badge"
import { presentHostStatus } from "~/lib/host-status"

export type HostStatusBadgeProps = {
	status: HostStatus
}

export const HostStatusBadge = ({ status }: HostStatusBadgeProps) => {
	const presentation = presentHostStatus(status)
	return <Badge variant={presentation.variant}>{presentation.label}</Badge>
}

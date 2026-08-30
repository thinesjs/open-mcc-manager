import type { HostStatus } from "@open-mcc/contracts"

export type StatusVariant = "success" | "warning" | "error" | "info" | "update"

export type HostStatusPresentation = {
	label: string
	variant: StatusVariant
}

const PRESENTATION_BY_STATUS: Record<HostStatus, HostStatusPresentation> = {
	pending: { label: "Pending", variant: "update" },
	provisioning: { label: "Provisioning", variant: "warning" },
	ready: { label: "Ready", variant: "success" },
	unreachable: { label: "Unreachable", variant: "error" },
	error: { label: "Error", variant: "error" },
}

export const presentHostStatus = (status: HostStatus): HostStatusPresentation =>
	PRESENTATION_BY_STATUS[status]

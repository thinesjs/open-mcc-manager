import type { InstanceStatus } from "@open-mcc/contracts"
import type { StatusVariant } from "~/lib/host-status"

export type InstanceStatusPresentation = {
	label: string
	variant: StatusVariant
	description: string
}

const PRESENTATION_BY_STATUS: Record<InstanceStatus, InstanceStatusPresentation> = {
	created: {
		label: "Created",
		variant: "update",
		description: "Provisioned on its host but never authenticated.",
	},
	needs_auth: {
		label: "Needs auth",
		variant: "warning",
		description: "Waiting for a Microsoft sign-in to finish before it can start.",
	},
	stopped: {
		label: "Stopped",
		variant: "info",
		description: "Authenticated and idle. Start it to begin play.",
	},
	running: {
		label: "Running",
		variant: "success",
		description: "Connected and supervised by systemd.",
	},
	error: {
		label: "Error",
		variant: "error",
		description: "The client exited in a way the supervisor will not retry.",
	},
}

export const presentInstanceStatus = (status: InstanceStatus): InstanceStatusPresentation =>
	PRESENTATION_BY_STATUS[status]

export const ATTENTION_STATUSES: ReadonlySet<InstanceStatus> = new Set<InstanceStatus>([
	"needs_auth",
	"error",
])

export const needsAttention = (status: InstanceStatus): boolean => ATTENTION_STATUSES.has(status)

export const MCC_EXIT_CODE_REASONS: Record<number, string> = {
	0: "Exited cleanly.",
	1: "Exited for an unknown reason.",
	2: "Kicked in game.",
	3: "Lost its connection to the server.",
	4: "Sign-in did not complete. The supervisor will not restart it, so a wrong account or an expired token cannot hammer Microsoft — but a network fault during sign-in ends here too. Re-authenticate, or start it again once the network is healthy.",
}

export const describeExitCode = (code: number | null): string | undefined =>
	code === null ? undefined : MCC_EXIT_CODE_REASONS[code]

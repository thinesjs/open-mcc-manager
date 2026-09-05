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
		description: "Provisioned. Authentication required.",
	},
	needs_auth: {
		label: "Needs auth",
		variant: "warning",
		description: "Awaiting Microsoft sign-in.",
	},
	stopped: {
		label: "Stopped",
		variant: "info",
		description: "Authenticated. Not running.",
	},
	running: {
		label: "Running",
		variant: "success",
		description: "Running under systemd supervision.",
	},
	error: {
		label: "Error",
		variant: "error",
		description: "Exited with a status the supervisor will not retry.",
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
	0: "Clean exit.",
	1: "Unknown exit status.",
	2: "Kicked from server.",
	3: "Connection lost.",
	4: "Sign-in failed. Automatic restart is disabled for this status. Re-authenticate, or start the instance manually once the cause is resolved.",
}

export const describeExitCode = (code: number | null): string | undefined =>
	code === null ? undefined : MCC_EXIT_CODE_REASONS[code]

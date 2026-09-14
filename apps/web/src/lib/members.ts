import type { Role } from "@open-mcc/contracts"

export const ROLE_LABELS: Record<Role, string> = {
	owner: "Owner",
	operator: "Operator",
	viewer: "Viewer",
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
	viewer: "Sees everything. Changes nothing.",
	operator: "Runs bots and edits their settings.",
	owner: "Everything, including hosts, keys and members.",
}

export const invitationLink = (origin: string, invitationId: string): string =>
	`${origin}/accept-invitation?${new URLSearchParams({ invitation: invitationId }).toString()}`

export const hasExpired = (expiresAt: Date | string, now: number): boolean =>
	new Date(expiresAt).getTime() <= now

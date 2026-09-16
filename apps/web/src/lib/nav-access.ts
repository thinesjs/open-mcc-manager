import { type Capability, can, type Role } from "@open-mcc/contracts"

const NEEDED: Record<string, Capability | undefined> = {
	"/alerts": "notification.read",
	"/members": "member.manage",
	"/audit": "audit.read",
}

export const navItemVisible = (role: Role | undefined, to: string): boolean => {
	const needed = NEEDED[to]
	if (needed === undefined) return true
	return role !== undefined && can(role, needed)
}

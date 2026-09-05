export type SessionProbe = {
	data?: { session?: { id?: string } | null } | null
	error?: { status?: number } | null
}

export type GuardDecision = "allow" | "redirect"

export const decideFromSession = (probe: SessionProbe): GuardDecision => {
	if (probe.error) return "allow"
	if (probe.data?.session) return "allow"
	return "redirect"
}

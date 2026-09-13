import { z } from "zod"
import { hostKeyFingerprint, hostMode } from "./host"

export const HOST_CHECK_NAMES = [
	"reachable",
	"systemd",
	"architecture",
	"client-runtime",
	"lingering",
	"confinement",
	"tcp-forwarding",
] as const

export type HostCheckName = (typeof HOST_CHECK_NAMES)[number]

export const hostCheckOutcome = z.enum(["pass", "fail", "warn", "skipped"])

export type HostCheckOutcome = z.infer<typeof hostCheckOutcome>

export const hostCheckResult = z.object({
	name: z.enum(HOST_CHECK_NAMES),
	outcome: hostCheckOutcome,
	detail: z.string(),
})

export type HostCheckResult = z.infer<typeof hostCheckResult>

export const hostCheckReport = z.object({
	ready: z.boolean(),
	checks: z.array(hostCheckResult),
})

export type HostCheckReport = z.infer<typeof hostCheckReport>

export const checkHostInput = z.object({
	hostname: z.string().min(1).max(255),
	port: z.number().int().min(1).max(65535).default(22),
	username: z.string().min(1).max(64),
	mode: hostMode,
	sshKeyId: z.string().min(1),
	expectedFingerprint: hostKeyFingerprint,
})

export type CheckHostInput = z.infer<typeof checkHostInput>

export const HOST_CHECK_LABELS: Record<HostCheckName, string> = {
	reachable: "SSH reachable",
	systemd: "systemd present",
	architecture: "Supported architecture",
	"client-runtime": "Client dependencies",
	lingering: "Lingering enabled",
	confinement: "Instance confinement",
	"tcp-forwarding": "SSH port forwarding",
}

export const isBlocking = (check: HostCheckResult): boolean => check.outcome === "fail"

export const reportFrom = (checks: readonly HostCheckResult[]): HostCheckReport => ({
	ready: checks.every((check) => !isBlocking(check)),
	checks: [...checks],
})

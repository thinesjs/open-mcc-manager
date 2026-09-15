import { z } from "zod"
import { hostKeyFingerprint } from "./host"

export const HOST_CHECK_NAMES = [
	"reachable",
	"account",
	"systemd",
	"architecture",
	"lingering",
	"podman",
	"cgroups",
	"subordinate-ids",
	"network-helper",
	"storage",
	"tcp-forwarding",
	"cloud-metadata",
] as const

export type HostCheckName = (typeof HOST_CHECK_NAMES)[number]

export const hostCheckOutcome = z.enum(["pass", "fail", "warn", "skipped"])

export type HostCheckOutcome = z.infer<typeof hostCheckOutcome>

export const hostCheckResult = z.object({
	name: z.enum(HOST_CHECK_NAMES),
	outcome: hostCheckOutcome,
	detail: z.string(),
	command: z.string().nullable(),
	hint: z.string().nullable(),
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
	sshKeyId: z.string().min(1),
	expectedFingerprint: hostKeyFingerprint,
})

export type CheckHostInput = z.infer<typeof checkHostInput>

export const HOST_CHECK_LABELS: Record<HostCheckName, string> = {
	reachable: "SSH reachable",
	account: "Account",
	systemd: "systemd present",
	architecture: "Supported architecture",
	lingering: "Lingering enabled",
	podman: "Podman",
	cgroups: "Container support",
	"subordinate-ids": "Container access",
	"network-helper": "Network helper",
	storage: "Container storage",
	"tcp-forwarding": "SSH port forwarding",
	"cloud-metadata": "Cloud metadata",
}

export const isBlocking = (check: HostCheckResult): boolean => check.outcome === "fail"

export const reportFrom = (checks: readonly HostCheckResult[]): HostCheckReport => ({
	ready: checks.every((check) => !isBlocking(check)),
	checks: [...checks],
})

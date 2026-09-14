import { z } from "zod"

export const hostStatusSchema = z.enum([
	"pending",
	"provisioning",
	"ready",
	"unreachable",
	"error",
	"removing",
])

export type HostStatus = z.infer<typeof hostStatusSchema>

export const HOST_MODES = ["rootless", "system"] as const

export const hostMode = z.enum(HOST_MODES)

export type HostMode = z.infer<typeof hostMode>

export const HOST_KEY_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/

export const HOST_KEY_FINGERPRINT_REQUIREMENT = "Expected an OpenSSH SHA256 fingerprint"

export const hostKeyFingerprint = z
	.string()
	.regex(HOST_KEY_FINGERPRINT_PATTERN, HOST_KEY_FINGERPRINT_REQUIREMENT)

export const createHostInput = z.object({
	name: z.string().min(1).max(64),
	hostname: z.string().min(1).max(255),
	port: z.number().int().min(1).max(65535).default(22),
	username: z.string().min(1).max(64).default("root"),
	mode: hostMode.default("rootless"),
	sshKeyId: z.string().min(1),
	expectedFingerprint: hostKeyFingerprint,
})

export type CreateHostInput = z.infer<typeof createHostInput>

export const hostIdInput = z.object({ hostId: z.string().min(1) })
export type HostIdInput = z.infer<typeof hostIdInput>

export const hostPublic = z.object({
	id: z.string(),
	name: z.string(),
	hostname: z.string(),
	port: z.number().int(),
	username: z.string(),
	mode: hostMode,
	status: hostStatusSchema,
	hostKeyFingerprint: z.string().nullable(),
	hostKeyAlgorithm: z.string().nullable(),
	hostKeyTrustedAt: z.string().datetime().nullable(),
	hostKeyTrustedByLabel: z.string(),
	osId: z.string().nullable(),
	osName: z.string().nullable(),
	osRelease: z.string().nullable(),
	sandboxed: z.boolean().nullable(),
	lastSeenAt: z.string().datetime().nullable(),
	failedUnits: z.number().int().nullable(),
	provisioningStep: z.string().nullable(),
	provisioningStepIndex: z.number().int().nullable(),
	provisioningStepTotal: z.number().int().nullable(),
	provisioningError: z.string().nullable(),
	teardownError: z.string().nullable(),
	teardownRequestedAt: z.string().datetime().nullable(),
})
export type HostPublic = z.infer<typeof hostPublic>

export const retrustHostKeyInput = z.object({
	hostId: z.string().min(1),
	hostKeyFingerprint: hostKeyFingerprint,
})

export type RetrustHostKeyInput = z.infer<typeof retrustHostKeyInput>

export const LINGER_STEP_LABEL = "Checking that instances survive a logout"

export const CLIENT_RUNS_STEP_LABEL = "Checking the client runs"

export const SANDBOX_STEP_LABEL = "Checking that instances are confined"

export const PROVISION_STEP_LABELS = [
	"Checking systemd",
	"Creating the instances directory",
	"Reading the host architecture",
	"Downloading the client",
	"Verifying the download",
	"Installing the client",
	CLIENT_RUNS_STEP_LABEL,
	"Installing the instance unit",
	"Installing the sleep units",
	"Reloading systemd",
] as const

export const ROOTLESS_PROVISION_STEP_LABELS = [
	"Checking systemd",
	LINGER_STEP_LABEL,
	"Creating the instances directory",
	"Reading the host architecture",
	"Downloading the client",
	"Verifying the download",
	"Installing the client",
	CLIENT_RUNS_STEP_LABEL,
	SANDBOX_STEP_LABEL,
	"Installing the instance unit",
	"Installing the sleep units",
	"Reloading systemd",
] as const

export type ProvisionStepLabel =
	| (typeof PROVISION_STEP_LABELS)[number]
	| (typeof ROOTLESS_PROVISION_STEP_LABELS)[number]

export const provisionStepLabels = (mode: HostMode): readonly ProvisionStepLabel[] =>
	mode === "rootless" ? ROOTLESS_PROVISION_STEP_LABELS : PROVISION_STEP_LABELS

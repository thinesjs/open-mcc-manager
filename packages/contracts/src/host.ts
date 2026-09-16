import { z } from "zod"
import { ACCOUNT_NAME_PATTERN, ACCOUNT_NAME_REQUIREMENT } from "./host-setup"

export const hostStatusSchema = z.enum([
	"pending",
	"provisioning",
	"ready",
	"unreachable",
	"error",
	"removing",
])

export type HostStatus = z.infer<typeof hostStatusSchema>

export const NETWORK_STACKS = ["slirp4netns", "pasta"] as const

export type NetworkStack = (typeof NETWORK_STACKS)[number]

export const HOST_KEY_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/

export const HOST_KEY_FINGERPRINT_REQUIREMENT = "Expected an OpenSSH SHA256 fingerprint"

export const hostKeyFingerprint = z
	.string()
	.regex(HOST_KEY_FINGERPRINT_PATTERN, HOST_KEY_FINGERPRINT_REQUIREMENT)

export const createHostInput = z.object({
	name: z.string().min(1).max(64),
	hostname: z.string().min(1).max(255),
	port: z.number().int().min(1).max(65535).default(22),
	username: z.string().regex(ACCOUNT_NAME_PATTERN, ACCOUNT_NAME_REQUIREMENT),
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
	status: hostStatusSchema,
	hostKeyFingerprint: z.string().nullable(),
	hostKeyAlgorithm: z.string().nullable(),
	hostKeyTrustedAt: z.string().datetime().nullable(),
	hostKeyTrustedByLabel: z.string(),
	osId: z.string().nullable(),
	osName: z.string().nullable(),
	osRelease: z.string().nullable(),
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

export const PROVISION_STEP_LABELS = [
	"Checking systemd",
	LINGER_STEP_LABEL,
	"Checking Podman",
	"Setting up container storage",
	"Creating the instances directory",
	"Reading the host architecture",
	"Downloading the client",
	"Verifying the download",
	"Installing the client",
	"Downloading the runtime image",
	"Verifying the runtime image",
	CLIENT_RUNS_STEP_LABEL,
	"Installing the instance unit",
	"Installing the sleep units",
	"Reloading systemd",
] as const

export type ProvisionStepLabel = (typeof PROVISION_STEP_LABELS)[number]

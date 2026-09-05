import { z } from "zod"

export const hostStatusSchema = z.enum(["pending", "provisioning", "ready", "unreachable", "error"])

export type HostStatus = z.infer<typeof hostStatusSchema>

export const HOST_MODES = ["rootless", "system"] as const

export const hostMode = z.enum(HOST_MODES)

export type HostMode = z.infer<typeof hostMode>

export const createHostInput = z.object({
	name: z.string().min(1).max(64),
	hostname: z.string().min(1).max(255),
	port: z.number().int().min(1).max(65535).default(22),
	username: z.string().min(1).max(64).default("root"),
	mode: hostMode.default("rootless"),
	sshKeyId: z.string().min(1),
	expectedFingerprint: z
		.string()
		.regex(/^SHA256:[A-Za-z0-9+/]{43}$/, "Expected an OpenSSH SHA256 fingerprint"),
})

export type CreateHostInput = z.infer<typeof createHostInput>

export const hostIdInput = z.object({ hostId: z.string().min(1) })
export type HostIdInput = z.infer<typeof hostIdInput>

export const retrustHostKeyInput = z.object({
	hostId: z.string().min(1),
	hostKeyFingerprint: z
		.string()
		.regex(/^SHA256:[A-Za-z0-9+/]{43}$/, "Expected an OpenSSH SHA256 fingerprint"),
	hostKeyAlgorithm: z.string().min(1),
})

export type RetrustHostKeyInput = z.infer<typeof retrustHostKeyInput>

export const LINGER_STEP_LABEL = "Checking that instances survive a logout"

export const PROVISION_STEP_LABELS = [
	"Checking systemd",
	"Creating the instances directory",
	"Reading the host architecture",
	"Downloading the client",
	"Verifying the download",
	"Installing the client",
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
	"Installing the instance unit",
	"Installing the sleep units",
	"Reloading systemd",
] as const

export type ProvisionStepLabel =
	| (typeof PROVISION_STEP_LABELS)[number]
	| (typeof ROOTLESS_PROVISION_STEP_LABELS)[number]

export const provisionStepLabels = (mode: HostMode): readonly ProvisionStepLabel[] =>
	mode === "rootless" ? ROOTLESS_PROVISION_STEP_LABELS : PROVISION_STEP_LABELS

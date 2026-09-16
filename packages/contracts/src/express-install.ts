import { z } from "zod"
import { hostKeyFingerprint } from "./host"
import { ACCOUNT_NAME_PATTERN, ACCOUNT_NAME_REQUIREMENT } from "./host-setup"

export const EXPRESS_ROOT_USERNAME = "root"

export const ROOT_CREDENTIAL_KINDS = ["password", "key"] as const

export type RootCredentialKind = (typeof ROOT_CREDENTIAL_KINDS)[number]

export const MAX_ROOT_PASSWORD_LENGTH = 1024

export const MAX_ROOT_PRIVATE_KEY_LENGTH = 32768

export const rootCredentialInput = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("password"),
		password: z.string().min(1).max(MAX_ROOT_PASSWORD_LENGTH),
	}),
	z.object({
		kind: z.literal("key"),
		privateKey: z.string().min(1).max(MAX_ROOT_PRIVATE_KEY_LENGTH),
	}),
])

export type RootCredentialInput = z.infer<typeof rootCredentialInput>

export const readHostKeyInput = z.object({
	hostname: z.string().min(1).max(255),
	port: z.number().int().min(1).max(65535).default(22),
})

export type ReadHostKeyInput = z.infer<typeof readHostKeyInput>

export const hostKeyReport = z.object({
	fingerprint: hostKeyFingerprint,
	algorithm: z.string(),
})

export type HostKeyReport = z.infer<typeof hostKeyReport>

export const expressInstallInput = z.object({
	hostname: z.string().min(1).max(255),
	port: z.number().int().min(1).max(65535).default(22),
	username: z.string().regex(ACCOUNT_NAME_PATTERN, ACCOUNT_NAME_REQUIREMENT),
	sshKeyId: z.string().min(1),
	createAccount: z.boolean(),
	expectedFingerprint: hostKeyFingerprint,
	credential: rootCredentialInput,
	unlock: z.boolean().default(false),
})

export type ExpressInstallInput = z.infer<typeof expressInstallInput>

export const EXPRESS_INSTALL_OUTCOMES = [
	"ready",
	"locked",
	"key-mismatch",
	"refused",
	"credential-unreadable",
	"unreachable",
	"script-failed",
] as const

export type ExpressInstallOutcome = (typeof EXPRESS_INSTALL_OUTCOMES)[number]

export const expressInstallResult = z.discriminatedUnion("outcome", [
	z.object({ outcome: z.literal("ready"), fingerprint: hostKeyFingerprint }),
	z.object({ outcome: z.literal("locked"), account: z.string(), keepsPassword: z.boolean() }),
	z.object({ outcome: z.literal("key-mismatch") }),
	z.object({ outcome: z.literal("refused") }),
	z.object({ outcome: z.literal("credential-unreadable") }),
	z.object({ outcome: z.literal("unreachable"), reason: z.string() }),
	z.object({ outcome: z.literal("script-failed"), reason: z.string() }),
])

export type ExpressInstallResult = z.infer<typeof expressInstallResult>

export const INSTALL_MODES = ["express", "manual"] as const

export type InstallMode = (typeof INSTALL_MODES)[number]

export const EXPRESS_WARNING_TITLE = "Express runs commands as root"

export const EXPRESS_WARNING =
	"Express needs a root account. OpenMCC runs the setup commands as root on your server, uses the credential once and keeps none of it. Not the right choice for a critical machine."

export const EXPRESS_HOST_KEY_CONFIRMATION =
	"Confirm this matches the fingerprint in your provider's console: anything else in the path would receive your root credential. If you do not check it, you are trusting whatever answered at this address."

export const EXPRESS_REFUSED_MESSAGE = "The server did not accept that root password or key."

export const EXPRESS_KEY_MISMATCH_MESSAGE =
	"The server's key no longer matches the fingerprint you confirmed. Read it again before sending anything."

export const EXPRESS_KEY_UNREADABLE_MESSAGE =
	"That key could not be read. Paste the whole key, from its first line to its last. A key with a passphrase cannot be used here: use a key without one, or the root password."

export const EXPRESS_LOCKED_TITLE = "That account is locked"

export const expressLockedPrompt = (account: string): string =>
	`Unlock ${account} and run the setup again?`

export const EXPRESS_MANUAL_FALLBACK = "Run the command myself instead"

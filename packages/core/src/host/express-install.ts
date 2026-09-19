import {
	type ExpressInstallInput,
	type ExpressInstallResult,
	HOST_KEY_FINGERPRINT_PATTERN,
	hostSetupScript,
	LOCKED_KEEPS_PASSWORD,
	lockedNotice,
} from "@open-mcc/contracts"
import { type ExecResult, type RootCredential, RootHostKeyRejectedError } from "@open-mcc/transport"
import { redactValue } from "../security/redact"
import { COULD_NOT_CONNECT, connectFailureReason } from "./unreachable"

export const EXPRESS_CONNECT_TIMEOUT_MS = 20_000

export const EXPRESS_SETUP_TIMEOUT_MS = 600_000

export const EXPRESS_REASON_TAIL = 600

export const EXPRESS_TIMED_OUT_REASON =
	"The setup did not finish in time. It may still be running on the server."

export const EXPRESS_NO_REASON = "The setup stopped without saying why."

const KEY_REFUSED = "The server did not accept this SSH key"

const UNREADABLE_KEY = /^Cannot parse privateKey/

export const expressSetupCommand = (input: ExpressInstallInput, publicKey: string): string =>
	hostSetupScript(
		input.username,
		publicKey,
		input.createAccount,
		input.unlock ? "grant" : "ask",
		"none",
	)

export const rootCredentialFor = (input: ExpressInstallInput): RootCredential =>
	input.credential.kind === "password"
		? { kind: "password", password: input.credential.password }
		: { kind: "key", privateKey: input.credential.privateKey }

export const secretOf = (input: ExpressInstallInput): string =>
	input.credential.kind === "password" ? input.credential.password : input.credential.privateKey

export const connectFailureOutcome = (error: Error): ExpressInstallResult => {
	if (UNREADABLE_KEY.test(error.message)) return { outcome: "credential-unreadable" }
	if (error instanceof RootHostKeyRejectedError) return { outcome: "key-mismatch" }
	const reason = connectFailureReason(error)
	if (reason === KEY_REFUSED) return { outcome: "refused" }
	return { outcome: "unreachable", reason }
}

const tailOf = (text: string, secret: string): string => {
	const cleaned = redactValue(text, secret).trim()
	if (cleaned.length === 0) return EXPRESS_NO_REASON
	return cleaned.length <= EXPRESS_REASON_TAIL
		? cleaned
		: cleaned.slice(cleaned.length - EXPRESS_REASON_TAIL)
}

export const printedFingerprint = (stdout: string): string | null =>
	stdout
		.split("\n")
		.map((line) => line.trim())
		.find((line) => HOST_KEY_FINGERPRINT_PATTERN.test(line)) ?? null

export const scriptOutcome = (
	result: ExecResult,
	input: ExpressInstallInput,
	secret: string,
): ExpressInstallResult => {
	if (result.exitCode !== 0) {
		if (result.stderr.includes(lockedNotice(input.username))) {
			return {
				outcome: "locked",
				account: input.username,
				keepsPassword: result.stderr.includes(LOCKED_KEEPS_PASSWORD),
			}
		}
		return { outcome: "script-failed", reason: tailOf(result.stderr, secret) }
	}
	const fingerprint = printedFingerprint(result.stdout)
	if (fingerprint === null) {
		return { outcome: "script-failed", reason: tailOf(result.stderr, secret) }
	}
	if (fingerprint !== input.expectedFingerprint) return { outcome: "key-mismatch" }
	return { outcome: "ready", fingerprint }
}

export const runFailureOutcome = (error: Error, secret: string): ExpressInstallResult =>
	/timed out/i.test(error.message)
		? { outcome: "script-failed", reason: EXPRESS_TIMED_OUT_REASON }
		: {
				outcome: "script-failed",
				reason: redactValue(error.message.length > 0 ? error.message : COULD_NOT_CONNECT, secret),
			}

export const expressAuditDetail = (
	input: ExpressInstallInput,
	outcome: ExpressInstallResult,
): Record<string, string> => ({
	hostname: input.hostname,
	port: String(input.port),
	account: input.username,
	createAccount: String(input.createAccount),
	credentialKind: input.credential.kind,
	unlockRequested: String(input.unlock),
	fingerprint: input.expectedFingerprint,
	outcome: outcome.outcome,
})

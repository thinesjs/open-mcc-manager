import type { AddressProbeOutcome } from "@open-mcc/contracts"
import type { SshHandshake } from "@open-mcc/transport"
import { assertExhaustive } from "../lib/exhaustive"

export const ADDRESS_PROBE_TIMEOUT_MS = 5_000

const NO_ANSWER_CODES = ["ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN"]

const NOT_SSH_HANDSHAKE =
	/identification string|header line too long|greeting lines|expected newline/i

const outcomeForFailure = (error: Error): AddressProbeOutcome => {
	const code = "code" in error && typeof error.code === "string" ? error.code : ""
	if (NO_ANSWER_CODES.includes(code)) return "no-answer"
	if (code === "ECONNREFUSED") return "refused"
	if (code === "ETIMEDOUT") return "timed-out"
	const level = "level" in error && typeof error.level === "string" ? error.level : ""
	if (level === "client-dns") return "no-answer"
	if (level === "client-timeout" || /timed out/i.test(error.message)) return "timed-out"
	if (NOT_SSH_HANDSHAKE.test(error.message)) return "not-ssh"
	return "unclear"
}

export const addressProbeOutcomeFor = (handshake: SshHandshake): AddressProbeOutcome => {
	switch (handshake.kind) {
		case "key":
			return "answered"
		case "timed-out":
			return "timed-out"
		case "closed":
			return "unclear"
		case "failed":
			return outcomeForFailure(handshake.error)
		default:
			return assertExhaustive(handshake)
	}
}

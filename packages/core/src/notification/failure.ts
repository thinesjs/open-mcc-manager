const TIMED_OUT = "That address did not answer in time"

const REFUSED = "That address refused the connection"

const DROPPED = "That address closed the connection"

const UNREACHABLE = "That address could not be reached"

const INSECURE = "That address presented a certificate we could not trust"

export const DID_NOT_GO_THROUGH = "The delivery did not go through"

const REASONS: Readonly<Record<string, string>> = {
	UND_ERR_CONNECT_TIMEOUT: TIMED_OUT,
	UND_ERR_HEADERS_TIMEOUT: TIMED_OUT,
	UND_ERR_BODY_TIMEOUT: TIMED_OUT,
	ETIMEDOUT: TIMED_OUT,
	ECONNREFUSED: REFUSED,
	ECONNRESET: DROPPED,
	EPIPE: DROPPED,
	UND_ERR_SOCKET: DROPPED,
	EHOSTUNREACH: UNREACHABLE,
	ENETUNREACH: UNREACHABLE,
	ENETDOWN: UNREACHABLE,
	EAI_AGAIN: UNREACHABLE,
	ENOTFOUND: UNREACHABLE,
	CERT_HAS_EXPIRED: INSECURE,
	CERT_NOT_YET_VALID: INSECURE,
	CERT_SIGNATURE_FAILURE: INSECURE,
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: INSECURE,
	UNABLE_TO_GET_ISSUER_CERT: INSECURE,
	UNABLE_TO_GET_ISSUER_CERT_LOCALLY: INSECURE,
	SELF_SIGNED_CERT_IN_CHAIN: INSECURE,
	DEPTH_ZERO_SELF_SIGNED_CERT: INSECURE,
	ERR_TLS_CERT_ALTNAME_INVALID: INSECURE,
	ERR_TLS_INVALID_PROTOCOL_VERSION: INSECURE,
	ERR_SSL_WRONG_VERSION_NUMBER: INSECURE,
	HOSTNAME_MISMATCH: INSECURE,
}

const ownCode = (error: Error): string | undefined => {
	if (!("code" in error)) return undefined
	const code = error.code
	return typeof code === "string" ? code : undefined
}

const errorCode = (error: Error): string | undefined => {
	const own = ownCode(error)
	if (own !== undefined) return own
	if (!("cause" in error)) return undefined
	const cause = error.cause
	return cause instanceof Error ? ownCode(cause) : undefined
}

export const networkReason = (error: Error | undefined): string => {
	if (error === undefined) return DID_NOT_GO_THROUGH
	const code = errorCode(error)
	if (code !== undefined) {
		const known = REASONS[code]
		if (known !== undefined) return known
		if (code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL")) return INSECURE
		if (code.startsWith("CERT_") || code.startsWith("DEPTH_")) return INSECURE
		if (code.includes("SELF_SIGNED") || code.includes("UNABLE_TO_")) return INSECURE
	}
	if (error.name === "AbortError" || error.name === "TimeoutError") return TIMED_OUT
	return DID_NOT_GO_THROUGH
}

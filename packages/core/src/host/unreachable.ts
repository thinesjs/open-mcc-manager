const TIMED_OUT = "The server did not answer in time"

const REFUSED = "The server refused the connection"

const NOT_FOUND = "That address could not be found"

const NO_ROUTE = "That address could not be reached"

const DROPPED = "The server closed the connection"

const KEY_REFUSED = "The server did not accept this SSH key"

const HOST_KEY_MISMATCH = "The server's key did not match the fingerprint"

export const COULD_NOT_CONNECT = "Could not connect to the server"

const BY_CODE: Readonly<Record<string, string>> = {
	ETIMEDOUT: TIMED_OUT,
	ECONNREFUSED: REFUSED,
	ENOTFOUND: NOT_FOUND,
	EAI_AGAIN: NOT_FOUND,
	EHOSTUNREACH: NO_ROUTE,
	ENETUNREACH: NO_ROUTE,
	ENETDOWN: NO_ROUTE,
	ECONNRESET: DROPPED,
	EPIPE: DROPPED,
}

export const connectFailureReason = (error: Error): string => {
	const code = "code" in error && typeof error.code === "string" ? error.code : undefined
	const known = code === undefined ? undefined : BY_CODE[code]
	if (known !== undefined) return known
	const level = "level" in error && typeof error.level === "string" ? error.level : undefined
	if (level === "client-authentication") return KEY_REFUSED
	if (level === "client-dns") return NOT_FOUND
	if (level === "client-timeout" || /timed out/i.test(error.message)) return TIMED_OUT
	if (/host denied/i.test(error.message)) return HOST_KEY_MISMATCH
	return COULD_NOT_CONNECT
}

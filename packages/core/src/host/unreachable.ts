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

const stringField = (error: Error, field: "code" | "level"): string | undefined => {
	if (!(field in error)) return undefined
	const value = Reflect.get(error, field)
	return typeof value === "string" ? value : undefined
}

export const connectFailureReason = (error: Error): string => {
	const code = stringField(error, "code")
	const known = code === undefined ? undefined : BY_CODE[code]
	if (known !== undefined) return known
	const level = stringField(error, "level")
	if (level === "client-authentication") return KEY_REFUSED
	if (level === "client-dns") return NOT_FOUND
	if (level === "client-timeout" || /timed out/i.test(error.message)) return TIMED_OUT
	if (/host denied/i.test(error.message)) return HOST_KEY_MISMATCH
	return COULD_NOT_CONNECT
}

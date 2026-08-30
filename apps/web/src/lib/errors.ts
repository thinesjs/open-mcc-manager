export type TRPCErrorLike = {
	message: string
	data?: { errorCode?: string } | null | undefined
}

const ERROR_MESSAGES: Record<string, string> = {
	UNAUTHORIZED: "Your session has expired. Please sign in again.",
	FORBIDDEN: "You do not have permission to perform this action.",
	HOST_NOT_FOUND: "That host no longer exists.",
	SSH_KEY_NOT_FOUND: "That SSH key no longer exists.",
	FINGERPRINT_MISMATCH:
		"The key the host presented did not match the fingerprint you provided. Refusing to trust an unverified host.",
	HOST_MISCONFIGURED: "This host is missing configuration required for that action.",
	HOST_CONCURRENTLY_MODIFIED: "This host was changed by someone else. Refresh and try again.",
	HOST_PROVISIONING_IN_PROGRESS:
		"A provisioning attempt for this host is already in progress. Retry shortly.",
	INVITATION_NOT_FOUND: "This invitation is invalid, expired, or has already been used.",
}

const FALLBACK_MESSAGE = "Something went wrong. Please try again."

export const getErrorMessage = (error: TRPCErrorLike): string => {
	const errorCode = error.data?.errorCode
	const mapped = errorCode ? ERROR_MESSAGES[errorCode] : undefined
	if (mapped) return mapped
	return error.message.length > 0 ? error.message : FALLBACK_MESSAGE
}

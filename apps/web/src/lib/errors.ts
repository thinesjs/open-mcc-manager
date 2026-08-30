import { type ErrorCode, isErrorCode } from "@open-mcc/contracts"

export type TRPCErrorLike = {
	message: string
	data?: { errorCode?: string } | null | undefined
}

const ERROR_MESSAGES: Record<ErrorCode, string> = {
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
	SSH_KEY_IN_USE:
		"This SSH key is still in use by an enrolled host. Remove the hosts using it, then delete the key.",
	HOST_NAME_TAKEN: "A host with that name already exists. Choose a different name.",
	SSH_KEY_NAME_TAKEN: "An SSH key with that name already exists. Choose a different name.",
	CONSTRAINT_VIOLATION: "That change conflicts with data already stored. Refresh and try again.",
}

const FALLBACK_MESSAGE = "Something went wrong. Please try again."

export const getErrorMessage = (error: TRPCErrorLike): string => {
	const errorCode = error.data?.errorCode
	const mapped = isErrorCode(errorCode) ? ERROR_MESSAGES[errorCode] : undefined
	if (mapped) return mapped
	return error.message.length > 0 ? error.message : FALLBACK_MESSAGE
}

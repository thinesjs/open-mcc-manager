import {
	FingerprintMismatchError,
	ForbiddenError,
	HostConcurrentlyModifiedError,
	HostMisconfiguredError,
	HostNotFoundError,
	HostProvisioningInProgressError,
	SshKeyNotFoundError,
} from "@open-mcc/core"

export type MappedErrorCode = "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT"

export type MappedErrorTag =
	| "FORBIDDEN"
	| "HOST_NOT_FOUND"
	| "SSH_KEY_NOT_FOUND"
	| "FINGERPRINT_MISMATCH"
	| "HOST_MISCONFIGURED"
	| "HOST_CONCURRENTLY_MODIFIED"
	| "HOST_PROVISIONING_IN_PROGRESS"

export type MappedError = {
	code: MappedErrorCode
	errorCode: MappedErrorTag
	httpStatus: number
	message: string
}

const HTTP_STATUS_BY_CODE: Record<MappedErrorCode, number> = {
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	BAD_REQUEST: 400,
	CONFLICT: 409,
}

const mapped = (
	code: MappedErrorCode,
	errorCode: MappedErrorTag,
	message: string,
): MappedError => ({
	code,
	errorCode,
	httpStatus: HTTP_STATUS_BY_CODE[code],
	message,
})

export const mapKnownError = (cause: Error): MappedError | null => {
	if (cause instanceof ForbiddenError) {
		return mapped("FORBIDDEN", "FORBIDDEN", "You do not have permission to perform this action")
	}
	if (cause instanceof HostNotFoundError) {
		return mapped("NOT_FOUND", "HOST_NOT_FOUND", "Host not found")
	}
	if (cause instanceof SshKeyNotFoundError) {
		return mapped("NOT_FOUND", "SSH_KEY_NOT_FOUND", "SSH key not found")
	}
	if (cause instanceof FingerprintMismatchError) {
		return mapped(
			"BAD_REQUEST",
			"FINGERPRINT_MISMATCH",
			"Host key fingerprint does not match the trusted value",
		)
	}
	if (cause instanceof HostMisconfiguredError) {
		return mapped("BAD_REQUEST", "HOST_MISCONFIGURED", "Host is not configured for this operation")
	}
	if (cause instanceof HostConcurrentlyModifiedError) {
		return mapped(
			"CONFLICT",
			"HOST_CONCURRENTLY_MODIFIED",
			"Host was modified by a concurrent request",
		)
	}
	if (cause instanceof HostProvisioningInProgressError) {
		return mapped(
			"CONFLICT",
			"HOST_PROVISIONING_IN_PROGRESS",
			"Host provisioning is already in progress",
		)
	}
	return null
}

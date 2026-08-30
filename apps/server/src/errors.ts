import type { ErrorCode } from "@open-mcc/contracts"
import {
	FingerprintMismatchError,
	ForbiddenError,
	HostConcurrentlyModifiedError,
	HostMisconfiguredError,
	HostNotFoundError,
	HostProvisioningInProgressError,
	SshKeyInUseError,
	SshKeyNotFoundError,
} from "@open-mcc/core"
import { constraintViolationOf } from "@open-mcc/db"

export class InvitationNotFoundError extends Error {}

export type MappedErrorCode = "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT"

export type MappedError = {
	code: MappedErrorCode
	errorCode: ErrorCode
	httpStatus: number
	message: string
}

const HTTP_STATUS_BY_CODE: Record<MappedErrorCode, number> = {
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	BAD_REQUEST: 400,
	CONFLICT: 409,
}

const mapped = (code: MappedErrorCode, errorCode: ErrorCode, message: string): MappedError => ({
	code,
	errorCode,
	httpStatus: HTTP_STATUS_BY_CODE[code],
	message,
})

const CONSTRAINT_VIOLATIONS: Record<string, MappedError> = {
	host_org_name_unique: mapped(
		"CONFLICT",
		"HOST_NAME_TAKEN",
		"A host with that name already exists",
	),
	sshKey_org_name_unique: mapped(
		"CONFLICT",
		"SSH_KEY_NAME_TAKEN",
		"An SSH key with that name already exists",
	),
}

const UNNAMED_CONSTRAINT_VIOLATION = mapped(
	"CONFLICT",
	"CONSTRAINT_VIOLATION",
	"That change conflicts with data already stored",
)

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
	if (cause instanceof SshKeyInUseError) {
		return mapped("CONFLICT", "SSH_KEY_IN_USE", "SSH key is still in use by an enrolled host")
	}
	if (cause instanceof InvitationNotFoundError) {
		return mapped(
			"BAD_REQUEST",
			"INVITATION_NOT_FOUND",
			"Invitation not found, expired, or already used",
		)
	}
	const violation = constraintViolationOf(cause)
	if (violation) {
		return CONSTRAINT_VIOLATIONS[violation.constraint] ?? UNNAMED_CONSTRAINT_VIOLATION
	}
	return null
}

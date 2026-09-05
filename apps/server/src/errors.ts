import type { ErrorCode } from "@open-mcc/contracts"
import {
	FingerprintMismatchError,
	ForbiddenError,
	HostConcurrentlyModifiedError,
	HostHasInstancesError,
	HostMisconfiguredError,
	HostNotFoundError,
	HostProvisioningFailedError,
	HostProvisioningInProgressError,
	HostUnreachableError,
	InstanceAccountNotInteractiveError,
	InstanceAuthInProgressError,
	InstanceConcurrentlyModifiedError,
	InstanceHostNotFoundError,
	InstanceHostNotProvisionedError,
	InstanceNotFoundError,
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
	instance_org_name_unique: mapped(
		"CONFLICT",
		"INSTANCE_NAME_TAKEN",
		"An instance with that name already exists",
	),
	instance_host_org_fk: mapped(
		"CONFLICT",
		"HOST_HAS_INSTANCES",
		"That host still has instances on it; remove them first",
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
	if (cause instanceof InstanceNotFoundError) {
		return mapped("NOT_FOUND", "INSTANCE_NOT_FOUND", "Instance not found")
	}
	if (cause instanceof HostHasInstancesError) {
		return mapped("BAD_REQUEST", "HOST_HAS_INSTANCES", "That host still has instances on it")
	}
	if (cause instanceof HostProvisioningFailedError) {
		return mapped("BAD_REQUEST", "HOST_PROVISIONING_FAILED", cause.message)
	}
	if (cause instanceof HostUnreachableError) {
		return mapped("BAD_REQUEST", "HOST_UNREACHABLE", "Could not open an SSH session to this host")
	}
	if (cause instanceof InstanceHostNotProvisionedError) {
		return mapped(
			"BAD_REQUEST",
			"INSTANCE_HOST_NOT_READY",
			"That host has not been provisioned yet",
		)
	}
	if (cause instanceof InstanceHostNotFoundError) {
		return mapped(
			"BAD_REQUEST",
			"INSTANCE_HOST_NOT_READY",
			"That instance's host is not ready; enroll and provision it first",
		)
	}
	if (cause instanceof InstanceAccountNotInteractiveError) {
		return mapped(
			"BAD_REQUEST",
			"INSTANCE_ACCOUNT_NOT_INTERACTIVE",
			"This instance's account signs in without a device code",
		)
	}
	if (cause instanceof InstanceAuthInProgressError) {
		return mapped(
			"CONFLICT",
			"INSTANCE_AUTH_IN_PROGRESS",
			"This instance is being signed in to Microsoft; wait for that to finish",
		)
	}
	if (cause instanceof InstanceConcurrentlyModifiedError) {
		return mapped(
			"CONFLICT",
			"INSTANCE_CONCURRENTLY_MODIFIED",
			"This instance was changed by someone else. Refresh and try again",
		)
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

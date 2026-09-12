import {
	type ErrorCode,
	isErrorCode,
	REJECTION_ERROR_CODES,
	type RejectionCategory,
} from "@open-mcc/contracts"
import { McpProtocolError } from "@open-mcc/contracts/boundary/mcp"
import {
	DestinationDisabledError,
	DestinationHasNoSigningKeyError,
	DestinationKindImmutableError,
	DestinationNotFoundError,
	DestinationRejectedError,
	DestinationTestThrottledError,
	DisallowedInternalCommandError,
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
	InstanceConfigUnusableError,
	InstanceHostNotFoundError,
	InstanceHostNotProvisionedError,
	InstanceNotFoundError,
	LiveControlUnauthorizedError,
	LiveResponseTooLargeError,
	OrganizationTestThrottledError,
	SshKeyInUseError,
	SshKeyNotFoundError,
} from "@open-mcc/core"
import { constraintViolationOf } from "@open-mcc/db"
import { ChannelLimitReachedError } from "@open-mcc/transport"

export class InvitationNotFoundError extends Error {}

const codeForRejection = (category: RejectionCategory | undefined): ErrorCode => {
	if (category === undefined) return "DESTINATION_REJECTED"
	const code = REJECTION_ERROR_CODES[category]
	return isErrorCode(code) ? code : "DESTINATION_REJECTED"
}

export type MappedErrorCode =
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "BAD_REQUEST"
	| "CONFLICT"
	| "TOO_MANY_REQUESTS"

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
	TOO_MANY_REQUESTS: 429,
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
	if (cause instanceof DestinationRejectedError) {
		return mapped("BAD_REQUEST", codeForRejection(cause.category), cause.message)
	}

	if (cause instanceof DestinationTestThrottledError) {
		return mapped("TOO_MANY_REQUESTS", "DESTINATION_TEST_THROTTLED", cause.message)
	}

	if (cause instanceof OrganizationTestThrottledError) {
		return mapped("TOO_MANY_REQUESTS", "ORGANIZATION_TEST_THROTTLED", cause.message)
	}

	if (cause instanceof DestinationDisabledError) {
		return mapped("CONFLICT", "DESTINATION_DISABLED", cause.message)
	}

	if (cause instanceof DestinationKindImmutableError) {
		return mapped("BAD_REQUEST", "DESTINATION_KIND_IMMUTABLE", cause.message)
	}

	if (cause instanceof DestinationHasNoSigningKeyError) {
		return mapped("BAD_REQUEST", "DESTINATION_NO_SIGNING_KEY", cause.message)
	}

	if (cause instanceof DestinationNotFoundError) {
		return mapped("NOT_FOUND", "DESTINATION_NOT_FOUND", cause.message)
	}

	if (cause instanceof SshKeyInUseError) {
		return mapped("CONFLICT", "SSH_KEY_IN_USE", "SSH key is still in use by an enrolled host")
	}
	if (cause instanceof InstanceConfigUnusableError) {
		return mapped(
			"BAD_REQUEST",
			"INSTANCE_CONFIG_UNUSABLE",
			"These settings must be corrected before the bot can start",
		)
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
	if (cause instanceof McpProtocolError || cause instanceof LiveResponseTooLargeError) {
		return mapped(
			"CONFLICT",
			"INSTANCE_LIVE_CONTROL_UNREADABLE",
			"The client answered in a way this manager could not read",
		)
	}
	if (cause instanceof ChannelLimitReachedError) {
		return mapped(
			"CONFLICT",
			"HOST_CHANNEL_LIMIT",
			"The host refused another SSH session. Its MaxSessions limit is reached, so this is a limit rather than an unreachable host",
		)
	}
	if (cause instanceof LiveControlUnauthorizedError) {
		return mapped(
			"BAD_REQUEST",
			"INSTANCE_LIVE_CONTROL_REJECTED",
			"The client refused this manager's live control token. Re-save its settings and restart it",
		)
	}
	if (cause instanceof DisallowedInternalCommandError) {
		return mapped(
			"BAD_REQUEST",
			"INSTANCE_COMMAND_NOT_ALLOWED",
			"That client command is not one this manager will run",
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

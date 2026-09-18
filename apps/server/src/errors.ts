import {
	type ErrorCode,
	isErrorCode,
	REJECTION_ERROR_CODES,
	type RejectionCategory,
} from "@open-mcc/contracts"
import {
	type MccRefusal,
	McpProtocolError,
	McpRefusalError,
} from "@open-mcc/contracts/boundary/mcp"
import {
	AlertNotQueuedError,
	DestinationDisabledError,
	DestinationHasNoSigningKeyError,
	DestinationKindImmutableError,
	DestinationNotFoundError,
	DestinationRejectedError,
	DestinationTestThrottledError,
	DisallowedInternalCommandError,
	DoubleSlashCredentialError,
	FingerprintMismatchError,
	ForbiddenError,
	HostAnswerUnreadableError,
	HostConcurrentlyModifiedError,
	HostHasInstancesError,
	HostKeyUnreadableError,
	HostMisconfiguredError,
	HostNotFoundError,
	HostProvisioningFailedError,
	HostProvisioningInProgressError,
	HostRefusedError,
	HostRemovalNotStartedError,
	HostUnreachableError,
	InstanceAccountNotInteractiveError,
	InstanceAuthInProgressError,
	InstanceBotConfigUnusableError,
	InstanceBusyError,
	InstanceCommandNotSentError,
	InstanceConcurrentlyModifiedError,
	InstanceConfigUnusableError,
	InstanceConsoleUnreadableError,
	InstanceHostNotFoundError,
	InstanceHostNotProvisionedError,
	InstanceNotFoundError,
	InstanceNotRunningError,
	InstanceRemovalFailedError,
	InstanceSignInDidNotStartError,
	InstanceSignInNoDeviceCodeError,
	InstanceSignInRunningError,
	InstanceStartFailedError,
	InstanceStillInUseError,
	InstanceStopFailedError,
	LastOwnerError,
	LiveControlUnauthorizedError,
	LiveResponseTooLargeError,
	OrganizationTestThrottledError,
	SelfHostUnavailableError,
	SshKeyInUseError,
	SshKeyNotFoundError,
} from "@open-mcc/core"
import { constraintViolationOf } from "@open-mcc/db"
import {
	ChannelLimitReachedError,
	CommandAbortedError,
	LiveChannelUnavailableError,
	RootHostKeyRejectedError,
	StreamOverflowError,
	TransportInterruptedError,
} from "@open-mcc/transport"
import { isAPIError } from "better-auth/api"

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
	instanceConfig_instance_version_unique: mapped(
		"CONFLICT",
		"INSTANCE_CONCURRENTLY_MODIFIED",
		"This instance was changed by someone else. Refresh and try again",
	),
}

const UNNAMED_CONSTRAINT_VIOLATION = mapped(
	"CONFLICT",
	"CONSTRAINT_VIOLATION",
	"That change conflicts with data already stored",
)

const TURNED_OFF = mapped("CONFLICT", "INSTANCE_LIVE_TURNED_OFF", "The client has that turned off")

const REFUSALS: Record<MccRefusal, MappedError> = {
	capability_disabled: TURNED_OFF,
	feature_disabled: TURNED_OFF,
	disconnected: mapped(
		"CONFLICT",
		"INSTANCE_LIVE_NOT_JOINED",
		"The client is not connected to its server",
	),
	invalid_args: mapped(
		"BAD_REQUEST",
		"INSTANCE_LIVE_UNKNOWN_ITEM",
		"The client did not recognise that item",
	),
	invalid_state: mapped(
		"CONFLICT",
		"INSTANCE_LIVE_ITEM_MISSING",
		"The client does not have that item where it needs it",
	),
	action_failed: mapped(
		"CONFLICT",
		"INSTANCE_LIVE_ACTION_FAILED",
		"The client tried, but the game did not let it",
	),
}
const ALREADY_INVITED_CODES: ReadonlySet<string> = new Set([
	"USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION",
	"USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
])

const EXISTING_ACCOUNT_CODES: ReadonlySet<string> = new Set([
	"USER_ALREADY_EXISTS",
	"USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
])

export const mapKnownError = (cause: Error): MappedError | null => {
	if (cause instanceof McpRefusalError) return REFUSALS[cause.refusal]
	if (cause instanceof ForbiddenError) {
		return mapped("FORBIDDEN", "FORBIDDEN", "You do not have permission to perform this action")
	}
	if (cause instanceof HostNotFoundError) {
		return mapped("NOT_FOUND", "HOST_NOT_FOUND", "Host not found")
	}
	if (cause instanceof SshKeyNotFoundError) {
		return mapped("NOT_FOUND", "SSH_KEY_NOT_FOUND", "SSH key not found")
	}
	if (cause instanceof RootHostKeyRejectedError) {
		return mapped(
			"BAD_REQUEST",
			"FINGERPRINT_MISMATCH",
			"Host key fingerprint does not match the trusted value",
		)
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
	if (cause instanceof HostRemovalNotStartedError) {
		return mapped(
			"CONFLICT",
			"HOST_REMOVAL_NOT_STARTED",
			"This manager could not start removing this host, so nothing on it was changed",
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

	if (cause instanceof AlertNotQueuedError) {
		return mapped(
			"CONFLICT",
			"ALERT_NOT_QUEUED",
			"This manager could not accept this alert, so nothing was sent",
		)
	}

	if (cause instanceof SelfHostUnavailableError) {
		return mapped(
			"BAD_REQUEST",
			"SELF_HOST_UNAVAILABLE",
			"This deployment has no machine of its own that it can enroll",
		)
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
	if (cause instanceof InstanceBotConfigUnusableError) {
		return mapped(
			"BAD_REQUEST",
			"INSTANCE_BOT_CONFIG_UNUSABLE",
			"A bot setting cannot be used as it is",
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
	if (cause instanceof HostKeyUnreadableError) {
		return mapped("BAD_REQUEST", "HOST_KEY_UNREADABLE", cause.message)
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
	if (cause instanceof LiveChannelUnavailableError) {
		return mapped(
			"CONFLICT",
			"INSTANCE_LIVE_UNAVAILABLE",
			"The client's live channel is not available right now",
		)
	}
	if (cause instanceof HostAnswerUnreadableError) {
		return mapped(
			"CONFLICT",
			"HOST_ANSWER_UNREADABLE",
			"The host answered in a way this manager could not read",
		)
	}
	if (cause instanceof HostRefusedError) {
		return mapped("BAD_REQUEST", "HOST_REFUSED", "The host would not do what this manager asked")
	}
	if (cause instanceof TransportInterruptedError) {
		return mapped("CONFLICT", "HOST_NOT_ANSWERING", "The host did not answer in time")
	}
	if (cause instanceof CommandAbortedError || cause instanceof StreamOverflowError) {
		return mapped(
			"CONFLICT",
			"HOST_COMMAND_INTERRUPTED",
			"A command on the host stopped before it finished",
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
	if (cause instanceof DoubleSlashCredentialError) {
		return mapped(
			"BAD_REQUEST",
			"INSTANCE_COMMAND_DOUBLE_SLASH",
			"A command written with two slashes does not reach the server",
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
	if (cause instanceof InstanceSignInDidNotStartError) {
		return mapped(
			"BAD_REQUEST",
			"INSTANCE_SIGN_IN_DID_NOT_START",
			"The sign-in did not start on the host",
		)
	}
	if (cause instanceof InstanceSignInNoDeviceCodeError) {
		return mapped(
			"BAD_REQUEST",
			"INSTANCE_SIGN_IN_NO_DEVICE_CODE",
			"The sign-in started but no device code appeared",
		)
	}
	if (cause instanceof InstanceSignInRunningError) {
		return mapped(
			"CONFLICT",
			"INSTANCE_SIGN_IN_RUNNING",
			"Sign-in is running for this instance; try again when it is done",
		)
	}
	if (cause instanceof InstanceBusyError) {
		return mapped(
			"CONFLICT",
			"INSTANCE_BUSY",
			"This instance is busy with another change; try again in a moment",
		)
	}
	if (cause instanceof InstanceConcurrentlyModifiedError) {
		return mapped(
			"CONFLICT",
			"INSTANCE_CONCURRENTLY_MODIFIED",
			"This instance was changed by someone else. Refresh and try again",
		)
	}
	if (cause instanceof InstanceStillInUseError) {
		return mapped(
			"CONFLICT",
			"INSTANCE_STILL_IN_USE",
			"Something on the host is still using this instance, so it was not removed",
		)
	}
	if (cause instanceof InstanceRemovalFailedError) {
		return mapped(
			"BAD_REQUEST",
			"INSTANCE_REMOVAL_FAILED",
			"The host could not finish removing this instance, so it was not removed",
		)
	}
	if (cause instanceof InstanceStartFailedError) {
		return mapped("BAD_REQUEST", "INSTANCE_START_FAILED", "The host could not start this instance")
	}
	if (cause instanceof InstanceStopFailedError) {
		return mapped("BAD_REQUEST", "INSTANCE_STOP_FAILED", "The host could not stop this instance")
	}
	if (cause instanceof InstanceNotRunningError) {
		return mapped("CONFLICT", "INSTANCE_NOT_RUNNING", "This instance is not running")
	}
	if (cause instanceof InstanceCommandNotSentError) {
		return mapped(
			"BAD_REQUEST",
			"INSTANCE_COMMAND_NOT_SENT",
			"The command did not reach this instance",
		)
	}
	if (cause instanceof InstanceConsoleUnreadableError) {
		return mapped(
			"BAD_REQUEST",
			"INSTANCE_CONSOLE_UNREADABLE",
			"The host could not read this instance's output",
		)
	}
	if (cause instanceof LastOwnerError) {
		return mapped("CONFLICT", "MEMBER_LAST_OWNER", "An organization must keep at least one owner")
	}
	if (isAPIError(cause) && ALREADY_INVITED_CODES.has(String(cause.body?.code))) {
		return mapped(
			"CONFLICT",
			"MEMBER_ALREADY_INVITED",
			"That person is already a member or already has an invitation",
		)
	}
	if (isAPIError(cause) && EXISTING_ACCOUNT_CODES.has(String(cause.body?.code))) {
		return mapped(
			"CONFLICT",
			"INVITATION_EMAIL_HAS_ACCOUNT",
			"This email already has an account here",
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

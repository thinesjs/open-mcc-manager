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
	HOST_UNREACHABLE:
		"The control plane could not open an SSH session to this host. Check that the host is running, reachable on its address, and that its authorized_keys contains this deployment's public key.",
	HOST_PROVISIONING_FAILED:
		"Provisioning did not finish. The step it stopped on, and the reason, are shown on the host's page.",
	HOST_CONCURRENTLY_MODIFIED: "This host was changed by someone else. Refresh and try again.",
	HOST_PROVISIONING_IN_PROGRESS:
		"A provisioning attempt for this host is already in progress. Retry shortly.",
	INVITATION_NOT_FOUND: "This invitation is invalid, expired, or has already been used.",
	SSH_KEY_IN_USE:
		"This SSH key is still in use by an enrolled host. Remove the hosts using it, then delete the key.",
	HOST_NAME_TAKEN: "A host with that name already exists. Choose a different name.",
	SSH_KEY_NAME_TAKEN: "An SSH key with that name already exists. Choose a different name.",
	INSTANCE_NOT_FOUND: "That instance no longer exists. Refresh the list.",
	INSTANCE_HOST_NOT_READY:
		"That instance's host is not ready yet. Enroll and provision the host first.",
	HOST_CHANNEL_LIMIT:
		"The host would not open another SSH session. It has reached its session limit; wait a moment and retry.",
	INSTANCE_LIVE_CONTROL_REJECTED:
		"This instance refused the manager's live control token. Save its settings again and restart it.",
	INSTANCE_COMMAND_NOT_ALLOWED:
		"That client command is not one this manager will run. Chat and server commands still work.",
	INSTANCE_ACCOUNT_NOT_INTERACTIVE:
		"This instance signs in without a device code, so there is nothing to approve.",
	INSTANCE_AUTH_IN_PROGRESS:
		"This instance is being signed in to Microsoft. Wait for that to finish, then try again.",
	INSTANCE_CONCURRENTLY_MODIFIED:
		"This instance was changed by someone else. Refresh and try again.",
	INSTANCE_NAME_TAKEN: "An instance with that name already exists in this organization.",
	HOST_HAS_INSTANCES: "That host still has instances on it. Remove them before deleting the host.",
	CONSTRAINT_VIOLATION: "That change conflicts with data already stored. Refresh and try again.",
}

const FALLBACK_MESSAGE = "Something went wrong. Please try again."

export const getErrorMessage = (error: TRPCErrorLike): string => {
	const errorCode = error.data?.errorCode
	const mapped = isErrorCode(errorCode) ? ERROR_MESSAGES[errorCode] : undefined
	if (mapped) return mapped
	return error.message.length > 0 ? error.message : FALLBACK_MESSAGE
}

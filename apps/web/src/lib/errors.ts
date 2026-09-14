import { type ErrorCode, isErrorCode } from "@open-mcc/contracts"

export type TRPCErrorLike = {
	message: string
	data?: { errorCode?: string } | null | undefined
}

const ERROR_MESSAGES: Record<ErrorCode, string> = {
	UNAUTHORIZED: "Your session has expired. Please sign in again.",
	FORBIDDEN: "You do not have permission to perform this action.",
	HOST_NOT_FOUND: "That host no longer exists.",
	DESTINATION_NOT_FOUND: "That destination no longer exists. Refresh the list.",
	DESTINATION_TEST_THROTTLED:
		"This destination was tested a moment ago. Wait a minute before testing it again.",
	ORGANIZATION_TEST_THROTTLED:
		"Several destinations were tested just now. Wait a minute before testing another.",
	DESTINATION_DISABLED: "That destination is turned off. Turn it on before sending again.",
	DESTINATION_KIND_IMMUTABLE:
		"A destination cannot change where it sends to. Remove it and add a new one.",
	DESTINATION_NO_SIGNING_KEY: "Only a webhook has a signing key.",
	DESTINATION_REJECTED:
		"OpenMCC will not send alerts there. It needs an address on the internet reachable over https, unless an administrator has allowed your own network.",
	DESTINATION_POINTS_HERE:
		"That address points back at the machine OpenMCC runs on. An administrator has to allow it before alerts can be sent there.",
	DESTINATION_NOT_PUBLIC:
		"That address is on a private network. An administrator has to allow it before alerts can be sent there.",
	DESTINATION_NOT_USABLE:
		"That address is reserved and cannot receive anything. Check it and try again.",
	DESTINATION_NOT_AN_ADDRESS: "That does not look like a web address. Check it and try again.",
	DESTINATION_NOT_HTTPS:
		"The address has to start with https. Plain http is only allowed to an address an administrator has named.",
	DESTINATION_HAS_CREDENTIALS:
		"Remove the username and password from the address. Put the secret in the path or a header instead.",
	DESTINATION_HAS_FRAGMENT: "Remove the # and anything after it from the address.",
	DESTINATION_WRONG_HOST:
		"That address is not from the service you chose. Paste the address that service gave you.",
	DESTINATION_ADDRESS_RETIRED:
		"That Teams address no longer works. In Teams, add a Workflows webhook and paste the address it gives you.",
	DESTINATION_REQUIRES_SIGN_IN:
		"That workflow asks callers to sign in. Set its trigger access to Anyone, then paste the new address.",
	DESTINATION_HAS_PARAMETERS: "Give the server address only. Remove the ? and anything after it.",
	SSH_KEY_NOT_FOUND: "That SSH key no longer exists.",
	FINGERPRINT_MISMATCH:
		"The key the host presented did not match the fingerprint you provided. Refusing to trust an unverified host.",
	HOST_MISCONFIGURED: "This host is missing configuration required for that action.",
	HOST_UNREACHABLE:
		"OpenMCC could not reach this server. Check that it is running, reachable on its address, and that this key still has access.",
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
	INSTANCE_CONFIG_UNUSABLE:
		"These settings cannot be used as they are. Open Settings, correct them, and save.",
	INSTANCE_HOST_NOT_READY:
		"That instance's host is not ready yet. Enroll and provision the host first.",
	INSTANCE_LIVE_CONTROL_UNREADABLE:
		"This instance's live channel answered with something the manager could not read.",
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
	INSTANCE_STILL_IN_USE:
		"Something on the host is still using this instance, so it was not removed. Try again in a moment.",
	INSTANCE_REMOVAL_FAILED:
		"The host could not finish removing this instance, so it was not removed. Try again.",
	INSTANCE_NAME_TAKEN: "An instance with that name already exists in this organization.",
	HOST_HAS_INSTANCES: "That host still has instances on it. Remove them before deleting the host.",
	SELF_HOST_UNAVAILABLE:
		"OpenMCC cannot reach the machine it runs on, so it cannot add it. Run the installer on that machine again.",
	CONSTRAINT_VIOLATION: "That change conflicts with data already stored. Refresh and try again.",
}

const FALLBACK_MESSAGE = "Something went wrong. Please try again."

export const getErrorMessage = (error: TRPCErrorLike): string => {
	const errorCode = error.data?.errorCode
	const mapped = isErrorCode(errorCode) ? ERROR_MESSAGES[errorCode] : undefined
	if (mapped) return mapped
	return error.message.length > 0 ? error.message : FALLBACK_MESSAGE
}

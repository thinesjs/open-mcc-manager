import type { HostStatus } from "@open-mcc/contracts"

export const sawProvisioningFinish = (
	previous: HostStatus | undefined,
	current: HostStatus,
): boolean => previous === "provisioning" && current === "ready"

export const stillShowingCompletion = (current: HostStatus, wasComplete: boolean): boolean =>
	wasComplete && current === "ready"

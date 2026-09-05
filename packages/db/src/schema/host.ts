import type { Insertable, Selectable, SelectType } from "kysely"
import type { DB, Generated } from "../generated/database"

type RefinementOf<Narrowed extends Base, Base> = Narrowed

export type HostStatus = "pending" | "provisioning" | "ready" | "unreachable" | "error" | "removing"

type _HostStatusRefinesGeneratedColumn = RefinementOf<HostStatus, SelectType<DB["host"]["status"]>>

export type HostMode = "rootless" | "system"

type _HostModeRefinesGeneratedColumn = RefinementOf<HostMode, SelectType<DB["host"]["mode"]>>

export type HostTable = Omit<
	DB["host"],
	| "status"
	| "mode"
	| "instancesRoot"
	| "osId"
	| "failedUnits"
	| "teardownError"
	| "teardownRequestedAt"
	| "osName"
	| "sandboxed"
	| "unitDir"
	| "sshKeyId"
	| "hostKeyAlgorithm"
	| "hostKeyFingerprint"
	| "hostKeyTrustedBy"
	| "hostKeyTrustedAt"
	| "osRelease"
	| "cpuCount"
	| "memoryMb"
	| "lastSeenAt"
	| "provisioningAttemptId"
	| "provisioningClaimedAt"
> & {
	status: Generated<HostStatus>
	mode: Generated<HostMode>
	instancesRoot: Generated<DB["host"]["instancesRoot"]>
	osId: Generated<DB["host"]["osId"]>
	failedUnits: Generated<DB["host"]["failedUnits"]>
	teardownError: Generated<DB["host"]["teardownError"]>
	teardownRequestedAt: Generated<DB["host"]["teardownRequestedAt"]>
	osName: Generated<DB["host"]["osName"]>
	sandboxed: Generated<DB["host"]["sandboxed"]>
	unitDir: Generated<DB["host"]["unitDir"]>
	sshKeyId: Generated<DB["host"]["sshKeyId"]>
	hostKeyAlgorithm: Generated<DB["host"]["hostKeyAlgorithm"]>
	hostKeyFingerprint: Generated<DB["host"]["hostKeyFingerprint"]>
	hostKeyTrustedBy: Generated<DB["host"]["hostKeyTrustedBy"]>
	hostKeyTrustedAt: Generated<DB["host"]["hostKeyTrustedAt"]>
	osRelease: Generated<DB["host"]["osRelease"]>
	cpuCount: Generated<DB["host"]["cpuCount"]>
	memoryMb: Generated<DB["host"]["memoryMb"]>
	lastSeenAt: Generated<DB["host"]["lastSeenAt"]>
	provisioningAttemptId: Generated<DB["host"]["provisioningAttemptId"]>
	provisioningClaimedAt: Generated<DB["host"]["provisioningClaimedAt"]>
}

export type HostRow = Selectable<HostTable>
export type HostInsert = Insertable<HostTable>

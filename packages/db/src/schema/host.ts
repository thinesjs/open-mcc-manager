import type { Insertable, Selectable, SelectType } from "kysely"
import type { DB, Generated } from "../generated/database"

type RefinementOf<Narrowed extends Base, Base> = Narrowed

export type HostStatus = "pending" | "provisioning" | "ready" | "unreachable" | "error"

type _HostStatusRefinesGeneratedColumn = RefinementOf<HostStatus, SelectType<DB["host"]["status"]>>

export type HostTable = Omit<
	DB["host"],
	| "status"
	| "sshKeyId"
	| "hostKeyAlgorithm"
	| "hostKeyFingerprint"
	| "hostKeyTrustedBy"
	| "hostKeyTrustedAt"
	| "dockerVersion"
	| "osRelease"
	| "cpuCount"
	| "memoryMb"
	| "capacityLimit"
	| "lastSeenAt"
	| "provisioningAttemptId"
	| "provisioningClaimedAt"
> & {
	status: Generated<HostStatus>
	sshKeyId: Generated<DB["host"]["sshKeyId"]>
	hostKeyAlgorithm: Generated<DB["host"]["hostKeyAlgorithm"]>
	hostKeyFingerprint: Generated<DB["host"]["hostKeyFingerprint"]>
	hostKeyTrustedBy: Generated<DB["host"]["hostKeyTrustedBy"]>
	hostKeyTrustedAt: Generated<DB["host"]["hostKeyTrustedAt"]>
	dockerVersion: Generated<DB["host"]["dockerVersion"]>
	osRelease: Generated<DB["host"]["osRelease"]>
	cpuCount: Generated<DB["host"]["cpuCount"]>
	memoryMb: Generated<DB["host"]["memoryMb"]>
	capacityLimit: Generated<DB["host"]["capacityLimit"]>
	lastSeenAt: Generated<DB["host"]["lastSeenAt"]>
	provisioningAttemptId: Generated<DB["host"]["provisioningAttemptId"]>
	provisioningClaimedAt: Generated<DB["host"]["provisioningClaimedAt"]>
}

export type HostRow = Selectable<HostTable>
export type HostInsert = Insertable<HostTable>
